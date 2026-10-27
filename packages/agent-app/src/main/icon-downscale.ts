import { nativeImage } from 'electron';

/** #729: a plugin logo over the icon budget, scaled to fit `edge` (crisp at every size the app draws it). */
export function downscaleIcon(bytes: Buffer, edge: number): Buffer | null {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  return image.resize(width >= height ? { width: Math.min(edge, width), quality: 'best' } : { height: Math.min(edge, height), quality: 'best' }).toPNG();
}
