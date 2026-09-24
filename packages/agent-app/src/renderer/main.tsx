import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AreaBoundary } from './components/AreaBoundary';
import { boot } from './store';

const root = document.getElementById('root');
if (!root) throw new Error('renderer: #root missing');
createRoot(root).render(
  <React.StrictMode>
    <AreaBoundary area="Muster" scope="app"><App /></AreaBoundary>
  </React.StrictMode>,
);
void boot();
