export const OFFLINE_HTML_FILENAME = 'innovation-4th-edition-offline.html';

export function sanitizeStandaloneHtml(html: string): string {
  return html.replace(
    /<link\b[^>]*\brel=["'](?:manifest|apple-touch-icon)["'][^>]*\/?>\s*/gi,
    ''
  );
}

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

async function deliverHtmlFile(html: string, filename: string): Promise<void> {
  const cleanHtml = sanitizeStandaloneHtml(html);
  const blob = new Blob([cleanHtml], { type: 'text/html;charset=utf-8' });

  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof File === 'function' &&
    /iPad|iPhone|iPod/i.test(navigator.userAgent || '')
  ) {
    try {
      const file = new File([blob], filename, { type: 'text/html' });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Innovation 4th Edition (Offline)',
        });
        return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      // Fall through to standard Blob download
    }
  }

  triggerBlobDownload(blob, filename);
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
    await deliverHtmlFile(preMountSnapshot, OFFLINE_HTML_FILENAME);
    return;
  }

  if (isStandaloneHtml && window.location.protocol !== 'file:') {
    const response = await fetch(window.location.href, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to read bundled HTML (${response.status}).`);
    }
    const html = await response.text();
    await deliverHtmlFile(html, OFFLINE_HTML_FILENAME);
    return;
  }

  // Dev server fallback: ask Vite's in-memory singlefile export middleware to bundle cleanly
  const response = await fetch('/__offline_export.html', { cache: 'no-store' });
  if (!response.ok) {
    const msg = await response.text().catch(() => '');
    throw new Error(msg || `Offline HTML build failed (${response.status}).`);
  }
  const html = await response.text();
  await deliverHtmlFile(html, OFFLINE_HTML_FILENAME);
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'application/json;charset=utf-8'
): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  triggerBlobDownload(blob, filename);
}
