/** CUA-08: region selection over a displayed capture, mapped to the capture's real pixels. */
export interface Rect {x: number; y: number; width: number; height: number}
export const MIN_REGION_PX = 8;

/** Normalizes a drag (any direction) to a rect clamped inside the displayed image. */
export function dragRect(start: {x: number; y: number}, end: {x: number; y: number}, bounds: {width: number; height: number}): Rect {
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
  const x1 = clamp(Math.min(start.x, end.x), bounds.width), y1 = clamp(Math.min(start.y, end.y), bounds.height);
  const x2 = clamp(Math.max(start.x, end.x), bounds.width), y2 = clamp(Math.max(start.y, end.y), bounds.height);
  return {x: x1, y: y1, width: x2 - x1, height: y2 - y1};
}

/** Maps a rect in displayed CSS pixels to whole source pixels; null when the region is too small to be useful. */
export function sourceRegion(selection: Rect, displayed: {width: number; height: number}, natural: {width: number; height: number}): Rect | null {
  if (displayed.width <= 0 || displayed.height <= 0 || natural.width <= 0 || natural.height <= 0) return null;
  const sx = natural.width / displayed.width, sy = natural.height / displayed.height;
  const x = Math.max(0, Math.floor(selection.x * sx)), y = Math.max(0, Math.floor(selection.y * sy));
  const right = Math.min(natural.width, Math.ceil((selection.x + selection.width) * sx)), bottom = Math.min(natural.height, Math.ceil((selection.y + selection.height) * sy));
  const width = right - x, height = bottom - y;
  return width >= MIN_REGION_PX && height >= MIN_REGION_PX ? {x, y, width, height} : null;
}

/** Crops a PNG data URL in the renderer (canvas), so the attached region is exactly what the user saw selected. */
export async function cropDataUrl(dataUrl: string, region: Rect): Promise<string> {
  const image = new Image();
  image.decoding = 'async';
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('The capture could not be read.')); image.src = dataUrl; });
  const canvas = document.createElement('canvas');
  canvas.width = region.width; canvas.height = region.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The capture could not be cropped.');
  context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  return canvas.toDataURL('image/png');
}

/** Window text rides along as a plain-text attachment with a short provenance header. */
export function accessibilityAttachment(name: string, text: {app: string; window: string; text: string; truncated: boolean}): {name: string; text: string} {
  const base = name.replace(/\.png$/i, '');
  const header = [text.app && `App: ${text.app}`, text.window && `Window: ${text.window}`, 'Source: macOS Accessibility (visible text at capture time)'].filter(Boolean).join('\n');
  return {name: `${base} (window text).txt`, text: `${header}\n\n${text.text}${text.truncated ? '\n\n[truncated]' : ''}\n`};
}

/** UTF-8 text as base64 for attachments.stage (chunked: no argument-count limits on long text). */
export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
