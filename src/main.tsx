import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Capture pristine pre-mount single-file HTML snapshot in standalone builds
// so users can save/share a clean copy offline (including via file://) without mounted DOM nodes.
if (
  typeof document !== 'undefined' &&
  !document.querySelector('script[type="module"][src]')
) {
  (window as unknown as { __INNOVATION_OFFLINE_HTML__?: string }).__INNOVATION_OFFLINE_HTML__ =
    `<!doctype html>\n${document.documentElement.outerHTML}`;
}

if (typeof window !== 'undefined') {
  const isSecurePwaOrigin =
    window.location.protocol === 'https:' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  if (isSecurePwaOrigin && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
        // Ignore registration errors in restricted contexts
      });
    });
  }

  if (window.location.protocol === 'https:' && navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

createRoot(document.getElementById('root')!).render(<App />);
