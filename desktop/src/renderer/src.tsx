import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@voidr/capture-design-system/styles.css';
import './styles.css';

document.documentElement.dataset.platform = navigator.userAgent.includes('Macintosh')
  ? 'darwin'
  : navigator.userAgent.includes('Windows')
    ? 'win32'
    : 'linux';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
