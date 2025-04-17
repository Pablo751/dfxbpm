import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import DxfParser from 'dxf-parser';
import bmp from 'bmp-js';
import './App.css';

const IMAGE_WIDTH = 200;
const IMAGE_HEIGHT = 200;

function App() {
  const [bmpFiles, setBmpFiles] = useState([]);
  const [processingStatus, setProcessingStatus] = useState('');
  const [errors, setErrors] = useState([]);
  const [colorMode, setColorMode] = useState('black'); // 'black' or 'original'

  // Helper function to strip color from DXF content
  const stripDxfColors = (dxfContent) => {
    // Replace all instances of red color with black
    // In DXF, color is often specified with "62" (color code) group code
    // Red is often color 1 in DXF
    let modified = dxfContent;
    // Replace any color code 1 (red) with 0 (black)
    modified = modified.replace(/62\s*\n\s*1/g, '62\n0');
    return modified;
  };

  // Helper functions for drawing
  function getEntityPoints(entity) {
    const points = [];
    if (!entity || !entity.type) return points;

    switch (entity.type) {
      case 'LINE':
        if (entity.vertices && entity.vertices.length > 0) {
          points.push(...entity.vertices);
        }
        break;
      case 'LWPOLYLINE':
      case 'POLYLINE':
        if (entity.vertices && entity.vertices.length > 0) {
          points.push(...entity.vertices);
        }
        break;
      case 'CIRCLE':
        if (entity.center && typeof entity.radius === 'number') {
          points.push({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
          points.push({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
        }
        break;
      case 'ARC':
        if (entity.center && typeof entity.radius === 'number') {
          points.push({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
          points.push({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
        }
        break;
      default:
        break;
    }
    return points.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number' && !isNaN(p.x) && !isNaN(p.y));
  }

  function drawEntity(ctx, entity) {
    if (!entity || !entity.type) return;
    
    // Force black stroke at entity level
    if (colorMode === 'black') {
      // Force black color in multiple ways
      ctx.strokeStyle = '#000000';
      ctx.fillStyle = '#000000';
    } else {
      // Use a default color if original colors should be preserved
      ctx.strokeStyle = '#000000';
    }
    
    // Remove color from entity if present
    if (entity.color !== undefined) {
      entity.color = 0; // 0 is black in DXF
    }
    
    ctx.beginPath();
    switch (entity.type) {
      case 'LINE':
        if (entity.vertices && entity.vertices.length >= 2 && entity.vertices[0] && entity.vertices[1]) {
          ctx.moveTo(entity.vertices[0].x, entity.vertices[0].y);
          ctx.lineTo(entity.vertices[1].x, entity.vertices[1].y);
        }
        break;
      case 'LWPOLYLINE':
      case 'POLYLINE':
        if (entity.vertices && entity.vertices.length > 0 && entity.vertices[0]) {
          ctx.moveTo(entity.vertices[0].x, entity.vertices[0].y);
          for (let i = 1; i < entity.vertices.length; i++) {
            if (entity.vertices[i]) {
              ctx.lineTo(entity.vertices[i].x, entity.vertices[i].y);
            }
          }
          if (entity.closed || entity.shape || (entity.flags && (entity.flags & 1))) {
            ctx.closePath();
          }
        }
        break;
      case 'CIRCLE':
        if (entity.center && typeof entity.radius === 'number' && entity.radius > 0) {
          ctx.arc(entity.center.x, entity.center.y, entity.radius, 0, 2 * Math.PI);
        }
        break;
      case 'ARC':
        if (entity.center && typeof entity.radius === 'number' && entity.radius > 0 && typeof entity.startAngle === 'number' && typeof entity.endAngle === 'number') {
          const startAngleRad = -(entity.startAngle * Math.PI / 180);
          const endAngleRad = -(entity.endAngle * Math.PI / 180);
          ctx.arc(entity.center.x, entity.center.y, entity.radius, startAngleRad, endAngleRad, true);
        }
        break;
      default:
        break;
    }
    // Force black stroke again just to be sure
    if (colorMode === 'black') {
      ctx.strokeStyle = '#000000';
    }
    ctx.stroke();
  }

  // Direct pixel manipulation to ensure black lines
  const forceBlackLines = (imageData) => {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      // Check if pixel is reddish (high red, low green/blue)
      if (data[i] > 150 && data[i+1] < 100 && data[i+2] < 100) {
        data[i] = 0;       // R = 0
        data[i+1] = 0;     // G = 0
        data[i+2] = 0;     // B = 0
        data[i+3] = 255;   // A = 255 (full opacity)
      }
      // Also convert any non-white pixel to black
      else if (data[i] < 250 || data[i+1] < 250 || data[i+2] < 250) {
        data[i] = 0;       // R = 0
        data[i+1] = 0;     // G = 0
        data[i+2] = 0;     // B = 0
        data[i+3] = 255;   // A = 255
      }
    }
    return imageData;
  };

// Convierte Uint8ClampedArray RGBA (canvas) → Uint8Array ABGR (bmp‑js)
function rgbaToAbgr(rgbaData) {
  const len = rgbaData.length;
  const abgr = new Uint8Array(len);          // bmp‑js solo necesita Uint8Array
  for (let i = 0; i < len; i += 4) {
    abgr[i]     = rgbaData[i + 3];  // A
    abgr[i + 1] = rgbaData[i + 2];  // B
    abgr[i + 2] = rgbaData[i + 1];  // G
    abgr[i + 3] = rgbaData[i];      // R
  }
  return abgr;
}

  // Main processing function
  const processDxfFile = async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (event) => {
        try {
          let dxfContent = event.target.result;
          if (!dxfContent) {
            console.warn(`Empty content for file: ${file.name}`);
            reject({ fileName: file.name, message: 'Empty file or read error' });
            return;
          }

          // Modify DXF content to force black colors before parsing
          dxfContent = stripDxfColors(dxfContent);
          
          const parser = new DxfParser();
          let dxf;
          try {
            dxf = parser.parseSync(dxfContent);
          } catch (parseError) {
            console.error(`DXF parsing failed for ${file.name}:`, parseError);
            reject({ fileName: file.name, message: `DXF parsing error: ${parseError.message}` });
            return;
          }

          if (!dxf || !dxf.entities || dxf.entities.length === 0) {
            console.warn(`No entities found or parsed in ${file.name}`);
            resolve(null);
            return;
          }

          // Force color of all DXF entities to black
          if (dxf.entities && dxf.entities.length > 0) {
            dxf.entities.forEach(entity => {
              if (entity) {
                entity.color = 0; // 0 is black in DXF
                
                // Also adjust layer colors if they exist
                if (entity.layer && dxf.tables && dxf.tables.layer && dxf.tables.layer.layers) {
                  const layerName = entity.layer;
                  if (dxf.tables.layer.layers[layerName]) {
                    dxf.tables.layer.layers[layerName].color = 0;
                  }
                }
              }
            });
          }

          // Initialize canvas
          const canvas = document.createElement('canvas');
          canvas.width = IMAGE_WIDTH;
          canvas.height = IMAGE_HEIGHT;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject({ fileName: file.name, message: 'Could not get 2D context from canvas' });
            return;
          }

          // Fill with white background
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);

          // Calculate bounding box
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          let hasValidGeometry = false;

          dxf.entities.forEach(entity => {
            const points = getEntityPoints(entity);
            if (points.length > 0) {
              hasValidGeometry = true;
              points.forEach(p => {
                if (isFinite(p.x) && isFinite(p.y)) {
                  if (p.x < minX) minX = p.x;
                  if (p.x > maxX) maxX = p.x;
                  if (p.y < minY) minY = p.y;
                  if (p.y > maxY) maxY = p.y;
                }
              });
            }
          });

          if (!hasValidGeometry || minX === Infinity || maxX === -Infinity) {
            console.warn(`No processable/valid geometry found in ${file.name}`);
            resolve(null);
            return;
          }

          // Calculate scale and offset
          const drawingWidth = (maxX - minX) || 1;
          const drawingHeight = (maxY - minY) || 1;
          const padding = 0.05;
          const scaleX = (IMAGE_WIDTH * (1 - 2 * padding)) / drawingWidth;
          const scaleY = (IMAGE_HEIGHT * (1 - 2 * padding)) / drawingHeight;
          const scale = Math.min(scaleX, scaleY);

          const centerX = minX + drawingWidth / 2;
          const centerY = minY + drawingHeight / 2;
          const translateX = IMAGE_WIDTH / 2 - centerX * scale;
          const translateY = IMAGE_HEIGHT / 2 + centerY * scale;

          // Set drawing style to black for all entities
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1 / scale;

          // Draw entities
          ctx.save();
          ctx.translate(translateX, translateY);
          ctx.scale(scale, -scale);

          dxf.entities.forEach(entity => {
            drawEntity(ctx, entity);
          });

          ctx.restore();

          // Process the image data to ensure black lines
          let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          imageData = forceBlackLines(imageData);
          ctx.putImageData(imageData, 0, 0);

          /* ======== cambio clave aquí ======== */
          const abgrData = rgbaToAbgr(imageData.data);  // ← conversión RGBA→ABGR

          // Create monochrome (24 bit) BMP
          const bmpEncodedData = bmp.encode({
            data: abgrData,            // ← buffer ahora en el orden correcto
            width: canvas.width,
            height: canvas.height
          });
          /* =================================== */

          // Convert to base64
          let binaryString = '';
          const bytes = new Uint8Array(bmpEncodedData.data);
          for (let i = 0; i < bytes.byteLength; i++) {
            binaryString += String.fromCharCode(bytes[i]);
          }
          const base64String = btoa(binaryString);
          const bmpDataUrl = `data:image/bmp;base64,${base64String}`;

          resolve({
            name: file.name.replace(/\.[^/.]+$/, "") + ".bmp",
            dataUrl: bmpDataUrl,
          });

        } catch (err) {
          console.error(`Error processing ${file.name}:`, err);
          const message = err.message || (typeof err === 'string' ? err : 'Unknown processing error');
          reject({ fileName: file.name, message: message });
        }
      };

      reader.onerror = (err) => {
        console.error(`Error reading file ${file.name}:`, err);
        reject({ fileName: file.name, message: 'File reading failed' });
      };

      reader.readAsText(file);
    });
  };

  // Dropzone handling
  const onDrop = useCallback(async (acceptedFiles) => {
    setProcessingStatus(`Processing ${acceptedFiles.length} file(s)...`);
    setBmpFiles([]);
    setErrors([]);
    const newBmpFiles = [];
    const currentErrors = [];

    const results = await Promise.allSettled(
      acceptedFiles.map(file => {
        if (file.name.toLowerCase().endsWith('.dxf')) {
          return processDxfFile(file);
        } else {
          console.warn(`Skipping non-DXF file: ${file.name}`);
          return Promise.reject({ fileName: file.name, message: 'Not a DXF file' });
        }
      })
    );

    results.forEach((result, index) => {
      const originalFile = acceptedFiles[index];
      if (result.status === 'fulfilled') {
        if (result.value) {
          newBmpFiles.push(result.value);
        }
      } else {
        console.error("Error during file processing:", result.reason);
        const errorInfo = result.reason || {};
        currentErrors.push({
          fileName: errorInfo.fileName || originalFile.name,
          message: errorInfo.message || 'Unknown processing error'
        });
      }
    });

    setBmpFiles(newBmpFiles);
    setErrors(currentErrors);
    setProcessingStatus(
      `Processed ${acceptedFiles.length} file(s). Generated ${newBmpFiles.length} BMP(s). ${currentErrors.length > 0 ? `${currentErrors.length} error(s).` : ''}`
    );
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
      <h1>DXF to BMP Converter (Pure Black Lines)</h1>

      <div {...getRootProps()} className={`dropzone ${isDragActive ? 'active' : ''}`}>
        <input {...getInputProps()} />
        {isDragActive ? (
          <p>Drop the DXF files here ...</p>
        ) : (
          <p>Drag 'n' drop some DXF files here, or click to select files</p>
        )}
      </div>

      <div className="color-toggle" style={{ margin: '15px 0' }}>
        <label>
          <input
            type="radio"
            value="black"
            checked={colorMode === 'black'}
            onChange={() => setColorMode('black')}
          /> Force Black Lines
        </label>
        <label style={{ marginLeft: '15px' }}>
          <input
            type="radio"
            value="original"
            checked={colorMode === 'original'}
            onChange={() => setColorMode('original')}
          /> Original Colors
        </label>
      </div>

      {processingStatus && <p className="status">{processingStatus}</p>}

      {errors.length > 0 && (
        <div className="errors">
          <h2>Errors Encountered:</h2>
          <ul>
            {errors.map((error, index) => (
              <li key={index}><strong>{error.fileName}:</strong> {error.message}</li>
            ))}
          </ul>
        </div>
      )}

      {bmpFiles.length > 0 && (
        <div className="results">
          <h2>Generated BMP Files:</h2>
          <div className="image-grid">
            {bmpFiles.map((bmp, index) => (
              <div key={index} className="image-item">
                <img
                  src={bmp.dataUrl}
                  alt={`Preview of ${bmp.name}`}
                  width={IMAGE_WIDTH}
                  height={IMAGE_HEIGHT}
                  style={{ 
                    imageRendering: 'pixelated',
                    border: '1px solid #ccc',
                    background: 'white'
                  }}
                />
                <a
                  href={bmp.dataUrl}
                  download={bmp.name}
                  style={{ marginTop: '10px', display: 'inline-block' }}
                >
                  Download {bmp.name}
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;