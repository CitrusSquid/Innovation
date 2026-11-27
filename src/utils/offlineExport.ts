export const OFFLINE_HTML_FILENAME = 'innovation-4th-edition-offline.html';

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * Generates and downloads a standalone, self-contained single-file HTML document
 * containing all styles, scripts, cards, AI, and localStorage persistence.
 */
export async function downloadOfflineHtml(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const isStandaloneHtml = !document.querySelector('script[type="module"][src]');
  const preMountSnapshot = (
    window as unknown as { __INNOVATION_OFFLINE_HTML__?: string }
  ).__INNOVATION_OFFLINE_HTML__;

  if (isStandaloneHtml && preMountSnapshot) {
    const blob = new Blob([preMountSnapshot], { type: 'text/html;charset=utf-8' });
    triggerBlobDownload(blob, OFFLINE_HTML_FILENAME);
    return;
  }

  if (isStandaloneHtml && window.location.protocol !== 'file:') {
    const response = await fetch(window.location.href, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to read bundled HTML (${response.status}).`);
    }
    const html = await response.text();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    triggerBlobDownload(blob, OFFLINE_HTML_FILENAME);
    return;
  }

  // Dev server fallback: ask Vite's in-memory singlefile export middleware to bundle cleanly
  const response = await fetch('/__offline_export.html', { cache: 'no-store' });
  if (!response.ok) {
    const msg = await response.text().catch(() => '');
    throw new Error(msg || `Offline HTML build failed (${response.status}).`);
  }
  const html = await response.text();
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  triggerBlobDownload(blob, OFFLINE_HTML_FILENAME);
}

export function downloadTextFile(filename: string, content: string, mimeType = 'application/json;charset=utf-8'): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  triggerBlobDownload(blob, filename);
}
