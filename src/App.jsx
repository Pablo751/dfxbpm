import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import DxfParser from 'dxf-parser';
import './App.css';

const IMAGE_WIDTH = 200;
const IMAGE_HEIGHT = 200;

/**
 * Construye un BMP monocromo real (1 bpp) con cabecera, paleta y datos bit‑packed.
 */
function encode1BitBmp(width, height, monoData) {
  const rowBytes   = Math.ceil(width / 8);
  const paddedRow  = (rowBytes + 3) & ~3;      // cada fila múltiplo de 4 bytes
  const biSize     = 40;                       // tamaño BITMAPINFOHEADER
  const bfOffBits  = 14 + biSize + 2 * 4;      // fileHdr + infoHdr + paleta (2 entradas×4 bytes)
  const imageSize  = paddedRow * height;
  const fileSize   = bfOffBits + imageSize;
  
  const buf = new ArrayBuffer(fileSize);
  const dv  = new DataView(buf);
  let p = 0;

  // === BITMAPFILEHEADER (14 bytes) ===
  dv.setUint8 (p,   0x42);                 // 'B'
  dv.setUint8 (p+1, 0x4D);                 // 'M'
  dv.setUint32(p+2, fileSize, true);       p += 6;
  dv.setUint16(p,   0, true);              p += 2; // reservado
  dv.setUint16(p,   0, true);              p += 2; // reservado
  dv.setUint32(p,   bfOffBits, true);      p += 4;

  // === BITMAPINFOHEADER (40 bytes) ===
  dv.setUint32(p,   biSize, true);         p += 4;
  dv.setInt32 (p,   width, true);          p += 4;
  dv.setInt32 (p,   height, true);         p += 4;
  dv.setUint16(p,   1, true);              p += 2; // planes
  dv.setUint16(p,   1, true);              p += 2; // bit count = 1
  dv.setUint32(p,   0, true);              p += 4; // BI_RGB
  dv.setUint32(p,   imageSize, true);      p += 4; // tamaño datos
  dv.setUint32(p,   2835, true);           p += 4; // ppmX ≈72dpi
  dv.setUint32(p,   2835, true);           p += 4; // ppmY
  dv.setUint32(p,   2, true);              p += 4; // colores en paleta
  dv.setUint32(p,   0, true);              p += 4; // colores importantes

  // === PALETA (2×4 bytes: B,G,R,0) ===
  // índice 0 = blanco
  dv.setUint8(p++, 255);
  dv.setUint8(p++, 255);
  dv.setUint8(p++, 255);
  dv.setUint8(p++,   0);
  // índice 1 = negro
  dv.setUint8(p++,   0);
  dv.setUint8(p++,   0);
  dv.setUint8(p++,   0);
  dv.setUint8(p++,   0);

  // === DATOS DE PIXELES (monoData) ===
  const out = new Uint8Array(buf);
  out.set(monoData, bfOffBits);

  return out;
}

// Sustituye colores DXF (grupo 62): rojo (1) → negro (0)
function stripDxfColors(dxfContent) {
  return dxfContent.replace(/62\s*\n\s*1/g, '62\n0');
}

// Extrae los puntos de cada entidad para el bounding box
function getEntityPoints(entity) {
  const pts = [];
  if (!entity?.type) return pts;
  switch (entity.type) {
    case 'LINE':
      if (entity.vertices?.length >= 2) pts.push(...entity.vertices);
      break;
    case 'LWPOLYLINE':
    case 'POLYLINE':
      if (entity.vertices) pts.push(...entity.vertices);
      break;
    case 'CIRCLE':
      if (entity.center && typeof entity.radius === 'number') {
        pts.push(
          { x: entity.center.x - entity.radius, y: entity.center.y - entity.radius },
          { x: entity.center.x + entity.radius, y: entity.center.y + entity.radius }
        );
      }
      break;
    case 'ARC':
      if (entity.center && typeof entity.radius === 'number') {
        pts.push(
          { x: entity.center.x - entity.radius, y: entity.center.y - entity.radius },
          { x: entity.center.x + entity.radius, y: entity.center.y + entity.radius }
        );
      }
      break;
    default:
      break;
  }
  return pts.filter(p => isFinite(p.x) && isFinite(p.y));
}

// Traza cada entidad con stroke negro
function drawEntity(ctx, entity) {
  if (!entity?.type) return;
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  switch (entity.type) {
    case 'LINE':
      if (entity.vertices?.length >= 2) {
        ctx.moveTo(entity.vertices[0].x, entity.vertices[0].y);
        ctx.lineTo(entity.vertices[1].x, entity.vertices[1].y);
      }
      break;
    case 'LWPOLYLINE':
    case 'POLYLINE':
      if (entity.vertices?.length > 0) {
        ctx.moveTo(entity.vertices[0].x, entity.vertices[0].y);
        entity.vertices.slice(1).forEach(v => {
          if (v && isFinite(v.x) && isFinite(v.y)) {
            ctx.lineTo(v.x, v.y);
          }
        });
        if (entity.closed || entity.shape || (entity.flags & 1)) {
          ctx.closePath();
        }
      }
      break;
    case 'CIRCLE':
      if (entity.center && typeof entity.radius === 'number') {
        ctx.arc(entity.center.x, entity.center.y, entity.radius, 0, 2 * Math.PI);
      }
      break;
    case 'ARC':
      if (
        entity.center &&
        typeof entity.radius === 'number' &&
        typeof entity.startAngle === 'number' &&
        typeof entity.endAngle === 'number'
      ) {
        const start = -entity.startAngle * Math.PI / 180;
        const end = -entity.endAngle * Math.PI / 180;
        ctx.arc(entity.center.x, entity.center.y, entity.radius, start, end, true);
      }
      break;
    default:
      break;
  }
  ctx.stroke();
}


// Asegura que cualquier píxel no‑blanco pase a negro puro
function forceBlackLines(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250) {
      d[i] = d[i+1] = d[i+2] = 0;
      d[i+3] = 255;
    }
  }
  return imageData;
}

// Convierte el RGBA del canvas a un Uint8Array con 1 bit/píxel,
// filas padded a múltiplo de 4 bytes y orden bottom‑up
function rgbaTo1Bit(width, height, rgbaData) {
  const rowBytes  = Math.ceil(width / 8);
  const paddedRow = (rowBytes + 3) & ~3;
  const out       = new Uint8Array(paddedRow * height);

  for (let y = 0; y < height; y++) {
    const rowIndex = (height - 1 - y) * paddedRow;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = rgbaData[idx], g = rgbaData[idx+1], b = rgbaData[idx+2];
      if (r < 250 || g < 250 || b < 250) {
        out[rowIndex + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

function App() {
  const [bmpFiles, setBmpFiles]       = useState([]);
  const [processingStatus, setStatus] = useState('');
  const [errors, setErrors]           = useState([]);

  const processDxfFile = async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          let content = e.target.result;
          if (!content) throw new Error('Empty file');
          content = stripDxfColors(content);

          const parser = new DxfParser();
          let dxf;
          try { dxf = parser.parseSync(content); }
          catch (err) { throw new Error(`DXF parse error: ${err.message}`); }

          if (!dxf.entities?.length) return resolve(null);
          dxf.entities.forEach(ent => ent.color = 0);

          // ─── Setup canvas ───────────────────────────────
          const canvas = document.createElement('canvas');
          canvas.width  = IMAGE_WIDTH;
          canvas.height = IMAGE_HEIGHT;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('No 2D context');
          ctx.fillStyle = '#FFF';
          ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);

          // ─── Bounding box, escala y traslado ────────────
          let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
          dxf.entities.forEach(ent => {
            getEntityPoints(ent).forEach(p => {
              minX = Math.min(minX, p.x);
              minY = Math.min(minY, p.y);
              maxX = Math.max(maxX, p.x);
              maxY = Math.max(maxY, p.y);
            });
          });
          if (minX === Infinity) return resolve(null);
          const dw = maxX - minX || 1, dh = maxY - minY || 1;
          const pad = 0.05;
          const sX  = IMAGE_WIDTH  * (1 - 2*pad) / dw;
          const sY  = IMAGE_HEIGHT * (1 - 2*pad) / dh;
          const scale = Math.min(sX, sY);
          const cx = (minX + maxX)/2, cy = (minY + maxY)/2;
          const translateX = IMAGE_WIDTH/2 - cx*scale;
          const translateY = IMAGE_HEIGHT/2 + cy*scale;
          ctx.strokeStyle = '#000';
          ctx.lineWidth   = 1/scale;

          // ─── Dibujar entidades ──────────────────────────
          ctx.save();
          ctx.translate(translateX, translateY);
          ctx.scale(scale, -scale);
          dxf.entities.forEach(ent => drawEntity(ctx, ent));
          ctx.restore();

          // ─── Obtener pixels y forzar negro ─────────────
          let imgData = ctx.getImageData(0,0,canvas.width,canvas.height);
          imgData = forceBlackLines(imgData);
          ctx.putImageData(imgData, 0, 0);

          // ─── Convertir a 1bpp y generar BMP ────────────
          const monoData = rgbaTo1Bit(canvas.width, canvas.height, imgData.data);
          const bmpEncodedData = encode1BitBmp(canvas.width, canvas.height, monoData);

          // ─── Data URL y resolución ──────────────────────
          let bin = '';
          new Uint8Array(bmpEncodedData).forEach(b => bin += String.fromCharCode(b));
          const bmpDataUrl = 'data:image/bmp;base64,' + btoa(bin);

          resolve({
            name: file.name.replace(/\.[^/.]+$/, '') + '.bmp',
            dataUrl: bmpDataUrl
          });

        } catch (err) {
          reject({ fileName: file.name, message: err.message });
        }
      };
      reader.onerror = () => reject({ fileName: file.name, message: 'Read error' });
      reader.readAsText(file);
    });
  };

  const onDrop = useCallback(async (files) => {
    setStatus(`Processing ${files.length} file(s)...`);
    setBmpFiles([]);
    setErrors([]);
    const results = await Promise.allSettled(files.map(f => {
      if (f.name.toLowerCase().endsWith('.dxf')) return processDxfFile(f);
      return Promise.reject({ fileName: f.name, message: 'Not a DXF file' });
    }));
    const out = [], errs = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) out.push(r.value);
      else errs.push(r.reason || { fileName: files[i].name, message: 'Unknown error' });
    });
    setBmpFiles(out);
    setErrors(errs);
    setStatus(`Processed ${files.length} files. Generated ${out.length} BMP(s).${errs.length ? ' '+errs.length+' error(s).' : ''}`);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/dxf': ['.dxf'],
      'application/x-dxf': ['.dxf'],
      'image/vnd.dxf': ['.dxf'],
      'text/plain': ['.dxf']
    }
  });

  return (
    <div className="App">
      <h1>DXF to BMP Converter (1‑bit Monochrome)</h1>
      <div {...getRootProps()} className={`dropzone ${isDragActive ? 'active' : ''}`}>
        <input {...getInputProps()} />
        {isDragActive
          ? <p>Drop DXF files here…</p>
          : <p>Drag & drop DXF files here, or click to select</p>}
      </div>

      {processingStatus && <p className="status">{processingStatus}</p>}

      {errors.length > 0 && (
        <div className="errors">
          <h2>Errors:</h2>
          <ul>
            {errors.map((e, i) => <li key={i}><strong>{e.fileName}:</strong> {e.message}</li>)}
          </ul>
        </div>
      )}

      {bmpFiles.length > 0 && (
        <div className="results">
          <h2>Generated BMPs:</h2>
          <div className="image-grid">
            {bmpFiles.map((b, i) => (
              <div key={i} className="image-item">
                <img
                  src={b.dataUrl}
                  alt={b.name}
                  width={IMAGE_WIDTH}
                  height={IMAGE_HEIGHT}
                  style={{ imageRendering: 'pixelated', border: '1px solid #ccc', background: '#fff' }}
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
