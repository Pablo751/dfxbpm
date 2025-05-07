/*  App.jsx ─ DXF → BMP monocromo (1 bpp)
    Versión con:
      • Paleta corregida (índice 0 = negro, 1 = blanco)
      • Botón **Download All** que empaqueta todos los BMP en un ZIP
        (usa jszip + file‑saver)
*/
import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import DxfParser from 'dxf-parser';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import './App.css';

const IMAGE_WIDTH  = 175;
const IMAGE_HEIGHT = 175;

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

  /* PALETA */
  // 0 = negro
  dv.setUint8(p++, 0);  dv.setUint8(p++, 0);  dv.setUint8(p++, 0);  dv.setUint8(p++, 0);
  // 1 = blanco
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

function drawEntity(ctx, ent) {
  if (!ent?.type) return;
  ctx.strokeStyle = '#000'; // Outlines will be black
  ctx.fillStyle = '#000';   // Fills will be black
  ctx.beginPath();

  let isFillable = false; // Helper flag to decide if we should fill

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
          isFillable = true; // Mark as fillable if closed
        }
      }
      break;
    case 'CIRCLE':
      if (ent.center && typeof ent.radius === 'number') {
        ctx.arc(ent.center.x, ent.center.y, ent.radius, 0, 2 * Math.PI);
        isFillable = true; // Circles are always fillable
      }
      break;
    case 'ARC':
      // Standalone ARCs are generally not filled.
      // If an ARC is part of a closed POLYLINE, the POLYLINE's logic will handle filling.
      if (ent.center && typeof ent.radius === 'number' &&
          typeof ent.startAngle === 'number' && typeof ent.endAngle === 'number') {
        // The original arc drawing logic using negative angles and anticlockwise=true
        // attempts to map DXF's CCW angle system to canvas.
        // For DXF: Angles are CCW. 0 is East.
        // For Canvas: Angles are CW. 0 is East.
        // To draw a DXF arc (e.g., 0 to 90 deg CCW) on canvas:
        // canvasStart = -dxfStartAngleRad, canvasEnd = -dxfEndAngleRad, anticlockwise = true
        // This is what the original code does.
        const a0 = -ent.startAngle * Math.PI / 180;
        const a1 = -ent.endAngle   * Math.PI / 180;
        ctx.arc(ent.center.x, ent.center.y, ent.radius, a0, a1, true); // Draw CCW from a0 to a1
      }
      break;
    default:
      break;
  }

  if (isFillable) {
    ctx.fill(); // Fill the path if it's marked as fillable
  }
  ctx.stroke(); // Always stroke the outline
}

/* fuerza negro puro */
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

/* RGBA → 1 bpp (bottom‑up, padded)  – bit 1 = blanco, bit 0 = negro */
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
  const [bmpFiles, setBmpFiles]       = useState([]);
  const [processingStatus, setStatus] = useState('');
  const [errors, setErrors]           = useState([]);

  /* DXF → BMP */
  const processDxfFile = (file) =>
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

          const canvas = document.createElement('canvas');
          canvas.width = IMAGE_WIDTH; canvas.height = IMAGE_HEIGHT;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFF';
          ctx.fillRect(0,0,IMAGE_WIDTH,IMAGE_HEIGHT);

          /* bbox y transform */
          let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
          dxf.entities.forEach(e => getEntityPoints(e).forEach(p=>{
            minX=Math.min(minX,p.x); minY=Math.min(minY,p.y);
            maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y);
          }));
          if (minX===Infinity) return resolve(null);

          const dw=maxX-minX||1, dh=maxY-minY||1;
          const pad=0.05;
          const sx=IMAGE_WIDTH*(1-2*pad)/dw,
                sy=IMAGE_HEIGHT*(1-2*pad)/dh,
                scale=Math.min(sx,sy);
          const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
          const tx=IMAGE_WIDTH/2-cx*scale,
                ty=IMAGE_HEIGHT/2+cy*scale;
          ctx.lineWidth=1/scale;

          ctx.save();
          ctx.translate(tx,ty);
          ctx.scale(scale,-scale);
          dxf.entities.forEach(e=>drawEntity(ctx,e));
          ctx.restore();

          let imgData=ctx.getImageData(0,0,canvas.width,canvas.height);
          imgData=forceBlackLines(imgData);
          ctx.putImageData(imgData,0,0);

          const mono=rgbaTo1Bit(canvas.width,canvas.height,imgData.data);
          const bmp=encode1BitBmp(canvas.width,canvas.height,mono);

          let bin=''; new Uint8Array(bmp).forEach(b=>bin+=String.fromCharCode(b));
          const dataUrl='data:image/bmp;base64,'+btoa(bin);

          resolve({name:file.name.replace(/\.[^/.]+$/,'')+'.bmp',dataUrl});
        } catch(err){reject({fileName:file.name,message:err.message});}
      };
      reader.onerror = () => reject({fileName:file.name,message:'Read error'});
      reader.readAsText(file);
    });

  /* drag‑and‑drop */
  const onDrop = useCallback(async (files) => {
    setStatus(`Processing ${files.length} file(s)…`);
    setBmpFiles([]); setErrors([]);
    const results = await Promise.allSettled(files.map(f =>
      f.name.toLowerCase().endsWith('.dxf')
        ? processDxfFile(f)
        : Promise.reject({fileName:f.name,message:'Not a DXF file'})
    ));
    const outs=[], errs=[];
    results.forEach((r,i)=>{
      if(r.status==='fulfilled'&&r.value) outs.push(r.value);
      else errs.push(r.reason||{fileName:files[i].name,message:'Unknown error'});
    });
    setBmpFiles(outs); setErrors(errs);
    setStatus(`Processed ${files.length} files. Generated ${outs.length} BMP(s).${errs.length?' '+errs.length+' error(s).':''}`);
  }, []);

  const {getRootProps,getInputProps,isDragActive}=useDropzone({
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
    if (!bmpFiles.length) return;
    const zip = new JSZip();
    bmpFiles.forEach(({name,dataUrl}) => {
      const base64 = dataUrl.split(',')[1];
      zip.file(name, base64, {base64:true});
    });
    const blob = await zip.generateAsync({type:'blob'});
    saveAs(blob, 'dxf_bitmaps.zip');
  }, [bmpFiles]);

  return (
    <div className="App">
      <h1>DXF → BMP Converter (1‑bit)</h1>

      <div {...getRootProps()} className={`dropzone ${isDragActive?'active':''}`}>
        <input {...getInputProps()} />
        {isDragActive
          ? <p>Drop DXF files here…</p>
          : <p>Drag & drop DXF files here, or click to select</p>}
      </div>

      {processingStatus && <p className="status">{processingStatus}</p>}

      {errors.length>0 && (
        <div className="errors">
          <h2>Errors:</h2>
          <ul>{errors.map((e,i)=><li key={i}><strong>{e.fileName}:</strong> {e.message}</li>)}</ul>
        </div>
      )}

      {bmpFiles.length>0 && (
        <div className="results">
          <h2>Generated BMPs:</h2>
          <button onClick={downloadAll}>Download All</button>
          <div className="image-grid">
            {bmpFiles.map((b,i)=>(
              <div key={i} className="image-item">
                <img
                  src={b.dataUrl}
                  alt={b.name}
                  width={IMAGE_WIDTH}
                  height={IMAGE_HEIGHT}
                  style={{imageRendering:'pixelated',border:'1px solid #ccc',background:'#fff'}}
                />
                <a href={b.dataUrl} download={b.name}>Download {b.name}</a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
