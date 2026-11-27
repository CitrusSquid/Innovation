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

createRoot(document.getElementById('root')!).render(<App />);
