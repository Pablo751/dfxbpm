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
import tex1 from './assets/texture_felt.png';    
import tex2 from './assets/texture_plate.png'; 


const MODES = [
  { value: 'BMP',       label: 'BMP 1‑bit (lines)' },
  { value: 'PNG_FILL',  label: 'PNG Black Fill' },
  { value: 'PNG_TEX1',  label: 'PNG Carpet' },
  { value: 'PNG_TEX2',  label: 'PNG Rubber' },
  { value: 'JPG_FILL',  label: 'JPG Black Fill' },
  { value: 'JPG_TEX1',  label: 'JPG Carpet' },
  { value: 'JPG_TEX2',  label: 'JPG Rubber' },
];

const TEX1_SCALE = 1;   // rubber mat   (0.25 ≈ 4× denser than original)
const TEX2_SCALE = 0.5;      // diamond plate (unchanged)
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

/* Create a repeat pattern scaled by <scale> even on old browsers */
function createScaledPattern(ctx, img, scale) {
  if (scale === 1) return ctx.createPattern(img, 'repeat');

  /* Modern browsers (CanvasPattern.setTransform) */
  const pat = ctx.createPattern(img, 'repeat');
  if (pat && typeof pat.setTransform === 'function') {
    const m = new DOMMatrix();
    m.a = m.d = scale;          // scale X & Y
    pat.setTransform(m);
    return pat;
  }

  /* Fallback: draw the image into a smaller off‑screen tile */
  const w = Math.max(1, Math.round(img.width  * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const tile = document.createElement('canvas');
  tile.width = w; tile.height = h;
  tile.getContext('2d').drawImage(img, 0, 0, w, h);
  return ctx.createPattern(tile, 'repeat');
}

/*──────────────── Utilidad: agrupar segmentos LINE en polígonos cerrados ───────────────*/
function buildClosedPolygons(entities, tol = 1e-3) {
  /*  Devuelve un array de polígonos; cada polígono es un array de vértices
      [{x,y}, {x,y}, …] con el primer vértice repetido al final.
      Se consideran cerrados cuando el último punto coincide con el primero
      dentro de la tolerancia “tol”.                                                */
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < tol;

  /* Copia de los segmentos LINE que tengan 2 vértices válidos */
  const segs = entities
    .filter(e => e.type === 'LINE' && e.vertices?.length >= 2)
    .map(e => ({
      p0: { ...e.vertices[0] },
      p1: { ...e.vertices[1] },
      used: false,
    }));

  const polys = [];

  /* Construir caminos enlazando extremos iguales */
  for (const seg of segs) {
    if (seg.used) continue;
    const path = [seg.p0, seg.p1];
    seg.used = true;

    let extended = true;
    while (extended) {
      extended = false;
      for (const other of segs) {
        if (other.used) continue;
        const head = path[path.length - 1];
        if (near(head, other.p0)) {
          path.push(other.p1);
          other.used = true;
          extended = true;
          break;
        }
        if (near(head, other.p1)) {
          path.push(other.p0);
          other.used = true;
          extended = true;
          break;
        }
      }
    }

    /* ¿cierra sobre sí mismo? */
    if (path.length > 2 && near(path[0], path[path.length - 1])) {
      polys.push(path);
    }
  }
  return polys;
}

/*──────────────── DXF → Image (BMP / PNG) – función completa actualizada ──────────────*/
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

        /* Canvas --------------------------------------------------- */
        const scaleFactor = outMode === 'BMP' ? 1 : RENDER_SCALE;
        const canvas = document.createElement('canvas');
        canvas.width  = IMAGE_WIDTH  * scaleFactor;
        canvas.height = IMAGE_HEIGHT * scaleFactor;
        const ctx = canvas.getContext('2d');

        /* Background (only for BMP & solid‑fill modes) --------------- */
        if (outMode === 'BMP' || outMode === 'PNG_FILL' || outMode === 'JPG_FILL') {
          ctx.fillStyle = '#FFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        /* BBox & transform ----------------------------------------- */
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        dxf.entities.forEach(e =>
          getEntityPoints(e).forEach(p => {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          })
        );
        if (minX === Infinity) return resolve(null);

        const dw = maxX - minX || 1,
          dh = maxY - minY || 1,
          pad = 0.05;
        const sx = (canvas.width  * (1 - 2 * pad)) / dw,
          sy = (canvas.height * (1 - 2 * pad)) / dh,
          scale = Math.min(sx, sy);
        const cx = (minX + maxX) / 2,
          cy = (minY + maxY) / 2;
        const tx = canvas.width  / 2 - cx * scale,
          ty = canvas.height / 2 + cy * scale;
        ctx.lineWidth = 1 / scale;

        /* 1: silueta (trazado + relleno) --------------------------- */
        ctx.save();
        ctx.translate(tx, ty);
        ctx.scale(scale, -scale);

        const fillShapes = outMode !== 'BMP';

        /*─ a) entidades habituales ─*/
        dxf.entities
          .filter(e => e.type !== 'CIRCLE' && e.type !== 'ARC')
          .forEach(e => drawEntity(ctx, e, fillShapes));

        /*─ b) reconstruir polígonos cerrados a partir de LINE ─*/
        if (fillShapes) {
          const polys = buildClosedPolygons(dxf.entities);
          polys.forEach(poly => {
            ctx.beginPath();
            ctx.moveTo(poly[0].x, poly[0].y);
            poly.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
            ctx.closePath();
            ctx.fill('evenodd');
          });
        }

        /* 2: taladros circulares ----------------------------------- */
        if (outMode !== 'BMP') {
          ctx.globalCompositeOperation = 'destination-out';
          dxf.entities
            .filter(e => e.type === 'CIRCLE' || e.type === 'ARC')
            .forEach(e => drawEntity(ctx, e, true));
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();

        const baseName = file.name.replace(/\.[^/.]+$/, '');

        /* ---------- BMP output ------------------------------------ */
        if (outMode === 'BMP') {
          let imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          imgData = forceBlackLines(imgData);
          ctx.putImageData(imgData, 0, 0);

          const mono = rgbaTo1Bit(canvas.width, canvas.height, imgData.data);
          const bmp = encode1BitBmp(canvas.width, canvas.height, mono);

          let bin = '';
          new Uint8Array(bmp).forEach(b => (bin += String.fromCharCode(b)));
          return resolve({
            name: `${baseName}.bmp`,
            dataUrl: `data:image/bmp;base64,${btoa(bin)}`,
          });
        }

        /* ---------- Solid‑black PNG / JPG -------------------------- */
        if (outMode === 'PNG_FILL' || outMode === 'JPG_FILL') {
          let outCan = canvas;
          if (scaleFactor !== 1) {
            outCan = document.createElement('canvas');
            outCan.width = IMAGE_WIDTH;
            outCan.height = IMAGE_HEIGHT;
            outCan.getContext('2d').drawImage(
              canvas,
              0,
              0,
              outCan.width,
              outCan.height
            );
          }
          const isJpg = outMode === 'JPG_FILL';
          return resolve({
            name: `${baseName}.${isJpg ? 'jpg' : 'png'}`,
            dataUrl: isJpg
              ? outCan.toDataURL('image/jpeg', 0.92)
              : outCan.toDataURL('image/png'),
          });
        }

        /* ---------- PNG / JPG with texture ------------------------- */
        const isCarpet = outMode === 'PNG_TEX1' || outMode === 'JPG_TEX1';
        const texSrc   = isCarpet ? tex1 : tex2;
        const texScale = isCarpet ? TEX1_SCALE : TEX2_SCALE;
        const isJpgTex = outMode === 'JPG_TEX1' || outMode === 'JPG_TEX2';

        const texImg = new Image();
        texImg.src = texSrc;
        texImg.onload = () => {
          const pattern = createScaledPattern(ctx, texImg, texScale);

          ctx.save();
          ctx.globalCompositeOperation = 'source-in';
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();

          ctx.save();
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = '#FFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.restore();

          let outCan = canvas;
          if (scaleFactor !== 1) {
            outCan = document.createElement('canvas');
            outCan.width = IMAGE_WIDTH;
            outCan.height = IMAGE_HEIGHT;
            outCan.getContext('2d').drawImage(
              canvas,
              0,
              0,
              outCan.width,
              outCan.height
            );
          }
          resolve({
            name: `${baseName}.${isJpgTex ? 'jpg' : 'png'}`,
            dataUrl: isJpgTex
              ? outCan.toDataURL('image/jpeg', 0.92)
              : outCan.toDataURL('image/png'),
          });
        };
        texImg.onerror = () =>
          reject({ fileName: file.name, message: 'Texture load error' });
      } catch (err) {
        reject({ fileName: file.name, message: err.message });
      }
    };
    reader.onerror = () =>
      reject({ fileName: file.name, message: 'Read error' });
    reader.readAsText(file);
  });

  /*──────────────── Image → JPG re-export (BMP, JPEG input) ──────────────────*/
  const processImageFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0);
          const baseName = file.name.replace(/\.[^/.]+$/, '');
          resolve({
            name: `${baseName}.jpg`,
            dataUrl: canvas.toDataURL('image/jpeg', 0.92),
          });
        };
        img.onerror = () =>
          reject({ fileName: file.name, message: 'Could not decode image' });
        img.src = reader.result;
      };
      reader.onerror = () =>
        reject({ fileName: file.name, message: 'Read error' });
      reader.readAsDataURL(file);
    });

  /* drag‑and‑drop */
  const onDrop = useCallback(async (files) => {
    setStatus(`Processing ${files.length} file(s)…`);
    setFilesOut([]); setErrors([]);
    const results = await Promise.allSettled(files.map(f => {
      const ext = f.name.toLowerCase().split('.').pop();
      if (ext === 'dxf') return processDxfFile(f, mode);
      if (ext === 'bmp' || ext === 'jpg' || ext === 'jpeg') return processImageFile(f);
      return Promise.reject({fileName:f.name, message:'Unsupported file type'});
    }));
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
      'text/plain':['.dxf'],
      'image/bmp':['.bmp'],
      'image/jpeg':['.jpg','.jpeg'],
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
      <h1>DXF → {MODES.find(m => m.value === mode)?.label ?? mode} Converter</h1>

      <label className="mode-toggle">
        Mode:&nbsp;
        <select value={mode} onChange={e => setMode(e.target.value)}>
          {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </label>

      <div {...getRootProps()} className={`dropzone ${isDragActive ? 'active' : ''}`}>
        <input {...getInputProps()} />
        {isDragActive
          ? <p>Drop files here…</p>
          : <p>Drop DXF, BMP, or JPEG files here, or click to select</p>}
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
