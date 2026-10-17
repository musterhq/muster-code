/**
 * Saving a visual: the browser's own download path, which the desktop shell turns into the native Save dialog (no file is
 * written until the person picks a place). Pure DOM helpers; nothing here reaches the network.
 */

/** Saves `blob` as `fileName` through a transient link. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = fileName; link.rel = 'noopener'; link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has been handed to the shell by now; keep the URL briefly in case the dialog is slow to read it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export const downloadText = (text: string, fileName: string, type: string): void => downloadBlob(new Blob([text], {type: `${type};charset=utf-8`}), fileName);

/** A standalone SVG file: XML header, explicit namespace. */
export function standaloneSvg(svg: string): string {
  const withNamespace = /<svg\b[^>]*\sxmlns=/i.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${withNamespace}\n`;
}

/** Rasterizes an SVG string on a canvas filled with `background` (a transparent PNG would vanish on a dark page). */
export async function svgToPngBlob(svg: string, width: number, height: number, background: string, scale = 2): Promise<Blob> {
  // A data: URL, not a blob: URL: Chromium taints a canvas that drew a blob-URL SVG containing <foreignObject> (Mermaid's HTML labels)
  // and refuses to export it; a data: URL image is not tainted.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standaloneSvg(svg))}`;
  const image = new Image();
  image.decoding = 'async';
  {
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('The drawing could not be converted to an image.')); image.src = url; });
    // Keep the bitmap inside what a canvas can hold on every platform.
    const k = Math.min(scale, 8192 / Math.max(width, height, 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * k)); canvas.height = Math.max(1, Math.round(height * k));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This window cannot draw images.');
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The image could not be saved.')), 'image/png'));
  }
}
