import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { boot } from './store';

const root = document.getElementById('root');
if (!root) throw new Error('renderer: #root missing');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
void boot();
