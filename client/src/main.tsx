import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toasts } from './lib/ui';
import Router from './router';
import './styles.css';
import { installAssetRecovery } from './lib/asset-recovery';

installAssetRecovery();

const rootEl = document.getElementById('root')!;
document.getElementById('prerender')?.remove();

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <Toasts>
        <Router />
      </Toasts>
    </BrowserRouter>
  </StrictMode>,
);

// Pas de cache applicatif : évite de réintroduire le mélange de chunks entre déploiements.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => undefined); });
}
