// src/main.jsx or src/index.js

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css'; // Or your main CSS import
import { Buffer } from 'buffer'; // Import the polyfill

// ---- ADD THIS ----
// Make Buffer globally available for libraries that expect it
window.Buffer = Buffer;
// globalThis is the more modern standard way to refer to the global object
globalThis.Buffer = Buffer;
// ------------------

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);