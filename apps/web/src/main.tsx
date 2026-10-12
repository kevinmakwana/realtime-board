import '@fontsource-variable/schibsted-grotesk';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { pinnedNode } from './lib/node';

pinnedNode(); // capture ?node= before in-app navigation drops the query string

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
