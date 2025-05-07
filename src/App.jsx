/*  App.jsx ─ DXF → Imagen (BMP 1‑bit o PNG relleno)
    • Modo A: BMP monocromo (líneas negras, sin relleno)
    • Modo B: PNG – Figuras negras rellenas, bordes suavizados, huecos blancos
    • Casilla para alternar modos
    • Botón “Download All” empaqueta BMP/PNG generados en un ZIP
*/
import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import DxfParser from 'dxf-parser';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import './App.css';

const IMAGE_WIDTH  = 175;
const IMAGE_HEIGHT = 175;
const RENDER_SCALE = 4;

/*──────────────── BMP 1 bpp ────────────────*/
function encode1BitBmp(width, height, monoData) {
  const rowBytes   = Math.ceil(width / 8);
  const paddedRow  = (rowBytes + 3) & ~3;
  const biSize     = 40;
  const bfOffBits  = 14 + biSize + 2 * 4;
  const imageSize  = paddedRow * height;
  const fileSize   = bfOffBits + imageSize;

  const buf = new ArrayBuffer(fileSize);
  const dv  = new DataView(buf);
  let p = 0;

  /* BITMAPFILEHEADER */
  dv.setUint8 (p,   0x42);
  dv.setUint8 (p+1, 0x4D);
  dv.setUint32(p+2, fileSize, true);       p += 6;
  dv.setUint16(p,   0, true);              p += 2;
  dv.setUint16(p,   0, true);              p += 2;
  dv.setUint32(p,   bfOffBits, true);      p += 4;

  /* BITMAPINFOHEADER */
  dv.setUint32(p,   biSize, true);         p += 4;
  dv.setInt32 (p,   width, true);          p += 4;
  dv.setInt32 (p,   height, true);         p += 4;
  dv.setUint16(p,   1, true);              p += 2;
  dv.setUint16(p,   1, true);              p += 2;
  dv.setUint32(p,   0, true);              p += 4;
  dv.setUint32(p,   imageSize, true);      p += 4;
  dv.setUint32(p,   2835, true);           p += 4;
  dv.setUint32(p,   2835, true);           p += 4;
  dv.setUint32(p,   2, true);              p += 4;
  dv.setUint32(p,   0, true);              p += 4;

  /* PALETA  – 0 = negro, 1 = blanco */
  dv.setUint8(p++, 0);   dv.setUint8(p++, 0);   dv.setUint8(p++, 0);   dv.setUint8(p++, 0);
  dv.setUint8(p++, 255); dv.setUint8(p++, 255); dv.setUint8(p++, 255); dv.setUint8(p++, 0);

  /* PIXELS */
  const out = new Uint8Array(buf);
  out.set(monoData, bfOffBits);

  return out;
}

/*────────── Utilidades DXF ─────────*/
const stripDxfColors = (s) => s.replace(/62\s*\n\s*1/g, '62\n0');

function getEntityPoints(ent) {
  const pts = [];
  if (!ent?.type) return pts;
  switch (ent.type) {
    case 'LINE':
      if (ent.vertices?.length >= 2) pts.push(...ent.vertices);
      break;
    case 'LWPOLYLINE':
    case 'POLYLINE':
      if (ent.vertices) pts.push(...ent.vertices);
      break;
    case 'CIRCLE':
    case 'ARC':
      if (ent.center && typeof ent.radius === 'number')
        pts.push(
          { x: ent.center.x - ent.radius, y: ent.center.y - ent.radius },
          { x: ent.center.x + ent.radius, y: ent.center.y + ent.radius }
        );
      break;
    default:
      break;
  }
  return pts.filter(p => isFinite(p.x) && isFinite(p.y));
}

/*  Dibuja una entidad DXF.
    • stroke siempre (líneas)
    • fill opcional para figuras cerradas (modo PNG)
*/
function drawEntity(ctx, ent, fillShapes = false) {
  if (!ent?.type) return;
  ctx.strokeStyle = '#000';
  ctx.fillStyle   = '#000';
  ctx.beginPath();

  let isClosedShape = false;

  switch (ent.type) {
    case 'LINE':
      if (ent.vertices?.length >= 2) {
        ctx.moveTo(ent.vertices[0].x, ent.vertices[0].y);
        ctx.lineTo(ent.vertices[1].x, ent.vertices[1].y);
      }
      break;

    case 'LWPOLYLINE':
    case 'POLYLINE':
      if (ent.vertices?.length > 0) {
        ctx.moveTo(ent.vertices[0].x, ent.vertices[0].y);
        ent.vertices.slice(1).forEach(v => {
          if (v && isFinite(v.x) && isFinite(v.y)) ctx.lineTo(v.x, v.y);
        });
        if (ent.closed || ent.shape || (ent.flags & 1)) {
          ctx.closePath();
          isClosedShape = true;
        }
      }
      break;

    case 'CIRCLE':
      if (ent.center && typeof ent.radius === 'number') {
        ctx.arc(ent.center.x, ent.center.y, ent.radius, 0, 2 * Math.PI);
        isClosedShape = true;
      }
      break;

    case 'ARC':
      if (ent.center && typeof ent.radius === 'number' &&
          typeof ent.startAngle === 'number' && typeof ent.endAngle === 'number') {
        const a0 = -ent.startAngle * Math.PI / 180;
        const a1 = -ent.endAngle   * Math.PI / 180;
        ctx.arc(ent.center.x, ent.center.y, ent.radius, a0, a1, true);
      }
      break;

    default:
      break;
  }

  ctx.stroke();
  if (fillShapes && isClosedShape) ctx.fill('evenodd');
}

/* fuerza negro puro (antialias → líneas suaves pero negras) */
function forceBlackLines(imgData) {
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250) {
      d[i] = d[i+1] = d[i+2] = 0;
      d[i+3] = 255;
    }
  }
  return imgData;
}

/* RGBA → 1 bpp (bottom‑up, padded) – bit 1 = blanco, 0 = negro */
function rgbaTo1Bit(w, h, rgba) {
  const rowBytes  = Math.ceil(w / 8);
  const paddedRow = (rowBytes + 3) & ~3;
  const out       = new Uint8Array(paddedRow * h);

  for (let y = 0; y < h; y++) {
    const rowIndex = (h - 1 - y) * paddedRow;
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = rgba[idx], g = rgba[idx+1], b = rgba[idx+2];
      if (r > 250 && g > 250 && b > 250) {
        out[rowIndex + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

/*─────────────────── componente ───────────────────*/
function App() {
  const [filesOut,     setFilesOut] = useState([]);   // {name,dataUrl}
  const [mode,         setMode]     = useState('BMP'); // 'BMP' | 'PNG'
  const [status,       setStatus]   = useState('');
  const [errors,       setErrors]   = useState([]);

  /* DXF → Imagen (BMP o PNG) */
  const processDxfFile = (file, outMode) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          let txt = reader.result;
          if (!txt) throw new Error('Empty file');
          txt = stripDxfColors(txt);

          const parser = new DxfParser();
          const dxf = parser.parseSync(txt);
          if (!dxf.entities?.length) return resolve(null);

          dxf.entities.forEach(e => e.color = 0);

          /* ───── canvas y contexto (≥res para PNG) ───── */
          const scaleFactor = outMode === 'PNG' ? RENDER_SCALE : 1;
          const canvas = document.createElement('canvas');
          canvas.width  = IMAGE_WIDTH  * scaleFactor;
          canvas.height = IMAGE_HEIGHT * scaleFactor;
          const ctx = canvas.getContext('2d');

          ctx.fillStyle = '#FFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          /* bbox y transformaciones */
          let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
          dxf.entities.forEach(e => getEntityPoints(e).forEach(p=>{
            minX=Math.min(minX,p.x); minY=Math.min(minY,p.y);
            maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y);
          }));
          if (minX === Infinity) return resolve(null);

          const dw = maxX - minX || 1, dh = maxY - minY || 1;
          const pad = 0.05;
          const sx = canvas.width  * (1 - 2*pad) / dw,
                sy = canvas.height * (1 - 2*pad) / dh,
                scale = Math.min(sx, sy);
          const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
          const tx = canvas.width  / 2 - cx * scale,
                ty = canvas.height / 2 + cy * scale;
          ctx.lineWidth = 1 / scale;

          /* ───── dibujado ───── */
          ctx.save();
          ctx.translate(tx, ty);
          ctx.scale(scale, -scale);

          if (outMode === 'PNG') {
            /* 1º: figuras/pl → relleno negro */
            dxf.entities
              .filter(e => e.type !== 'CIRCLE' && e.type !== 'ARC')
              .forEach(e => drawEntity(ctx, e, true));

            /* 2º: círculos/arcos → recorte blanco */
            ctx.globalCompositeOperation = 'destination-out';
            dxf.entities
              .filter(e => e.type === 'CIRCLE' || e.type === 'ARC')
              .forEach(e => drawEntity(ctx, e, true));

            ctx.globalCompositeOperation = 'source-over';
          } else {
            /* BMP: sólo líneas negras */
            dxf.entities.forEach(e => drawEntity(ctx, e, false));
          }

          ctx.restore();

          /* ───── salida según modo ───── */
          if (outMode === 'BMP') {
            let imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            imgData = forceBlackLines(imgData);
            ctx.putImageData(imgData, 0, 0);

            const mono = rgbaTo1Bit(canvas.width, canvas.height, imgData.data);
            const bmp  = encode1BitBmp(canvas.width, canvas.height, mono);

            let bin = ''; new Uint8Array(bmp).forEach(b => bin += String.fromCharCode(b));
            const dataUrl = 'data:image/bmp;base64,' + btoa(bin);

            resolve({
              name: file.name.replace(/\.[^/.]+$/, '') + '.bmp',
              dataUrl
            });

          } else { /* PNG */
            /* si se renderizó a más resolución, se reduce para guardar */
            let exportCanvas = canvas;
            if (scaleFactor !== 1) {
              const c2 = document.createElement('canvas');
              c2.width  = IMAGE_WIDTH;
              c2.height = IMAGE_HEIGHT;
              const c2ctx = c2.getContext('2d');
              c2ctx.drawImage(canvas, 0, 0, c2.width, c2.height);
              exportCanvas = c2;
            }
            const dataUrl = exportCanvas.toDataURL('image/png');
            resolve({
              name: file.name.replace(/\.[^/.]+$/, '') + '.png',
              dataUrl
            });
          }

        } catch(err){reject({fileName:file.name, message:err.message});}
      };
      reader.onerror = () => reject({fileName:file.name, message:'Read error'});
      reader.readAsText(file);
    });


  /* drag‑and‑drop */
  const onDrop = useCallback(async (files) => {
    setStatus(`Processing ${files.length} file(s)…`);
    setFilesOut([]); setErrors([]);
    const results = await Promise.allSettled(files.map(f =>
      f.name.toLowerCase().endsWith('.dxf')
        ? processDxfFile(f, mode)
        : Promise.reject({fileName:f.name, message:'Not a DXF file'})
    ));
    const outs=[], errs=[];
    results.forEach((r,i)=>{
      if(r.status==='fulfilled' && r.value) outs.push(r.value);
      else errs.push(r.reason || {fileName:files[i].name, message:'Unknown error'});
    });
    setFilesOut(outs); setErrors(errs);
    setStatus(`Processed ${files.length} files. Generated ${outs.length} file(s).${errs.length ? ' '+errs.length+' error(s).' : ''}`);
  }, [mode]);

  const {getRootProps,getInputProps,isDragActive} = useDropzone({
    onDrop,
    accept:{
      'application/dxf':['.dxf'],
      'application/x-dxf':['.dxf'],
      'image/vnd.dxf':['.dxf'],
      'text/plain':['.dxf']
    }
  });

  /*────────── Download All (ZIP) ──────────*/
  const downloadAll = useCallback(async () => {
    if (!filesOut.length) return;
    const zip = new JSZip();
    filesOut.forEach(({name,dataUrl}) => {
      const base64 = dataUrl.split(',')[1];
      zip.file(name, base64, {base64:true});
    });
    const blob = await zip.generateAsync({type:'blob'});
    saveAs(blob, 'dxf_images.zip');
  }, [filesOut]);

  return (
    <div className="App">
      <h1>DXF → {mode === 'BMP' ? 'BMP (1‑bit)' : 'PNG (Filled Black)'} Converter</h1>

      <label className="mode-toggle">
        <input
          type="checkbox"
          checked={mode === 'PNG'}
          onChange={e => setMode(e.target.checked ? 'PNG' : 'BMP')}
        />
        High Quality black filled PNG
      </label>

      <div {...getRootProps()} className={`dropzone ${isDragActive ? 'active' : ''}`}>
        <input {...getInputProps()} />
        {isDragActive
          ? <p>Suelta los DXF aquí…</p>
          : <p>Arrastra DXF aquí o haz clic para seleccionar</p>}
      </div>

      {status && <p className="status">{status}</p>}

      {errors.length > 0 && (
        <div className="errors">
          <h2>Errors:</h2>
          <ul>{errors.map((e,i)=><li key={i}><strong>{e.fileName}:</strong> {e.message}</li>)}</ul>
        </div>
      )}

      {filesOut.length > 0 && (
        <div className="results">
          <h2>Generated {mode}</h2>
          <button onClick={downloadAll}>Download All</button>
          <div className="image-grid">
            {filesOut.map((f,i)=>(
              <div key={i} className="image-item">
                <img
                  src={f.dataUrl}
                  alt={f.name}
                  width={IMAGE_WIDTH}
                  height={IMAGE_HEIGHT}
                  style={{
                    imageRendering: mode === 'BMP' ? 'pixelated' : 'auto',
                    border:'1px solid #ccc',
                    background:'#fff'
                  }}
                />
                <a href={f.dataUrl} download={f.name}>Download {f.name}</a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
