/**
 * Saving a visual: the browser's own download path, which the desktop shell turns into the native Save dialog (no file is
 * written until the person picks a place). Copying an image goes through the desktop shell's clipboard. Nothing here reaches the network.
 */
import {invoke} from '../../bridge';

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

/**
 * A standalone SVG file: XML header, explicit namespace. With `background` the root carries the theme's surface colour, so a
 * drawing made for a dark theme (light text) still reads when it is opened outside the app.
 */
export function standaloneSvg(svg: string, background?: string): string {
  let out = /<svg\b[^>]*\sxmlns=/i.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (background && /^[#\w(),.%\s-]+$/.test(background)) {
    const root = /<svg\b[^>]*>/i.exec(out)![0];
    const style = /\sstyle="([^"]*)"/i.exec(root);
    const tag = style ? root.replace(style[0], ` style="${style[1]!.replace(/;?\s*$/, ';')} background-color: ${background}"`) : root.replace(/<svg\b/i, `<svg style="background-color: ${background}"`);
    out = out.replace(root, () => tag);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${out}\n`;
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

/** A PNG as a `data:image/png;base64,…` URL. */
export async function pngDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * Puts a PNG on the system clipboard as an image. Through the main process: the window's session refuses every permission
 * request, so the page's own `navigator.clipboard.write` is denied.
 */
export async function copyPngImage(blob: Blob): Promise<void> {
  await invoke('clipboard.writeImage', {dataUrl: await pngDataUrl(blob)});
}
