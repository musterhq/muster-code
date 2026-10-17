/** Whether this window can draw the 3D device frame (#363). Checked once; the flat view is always available. */
let cached: boolean | undefined;
export function threeAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    const gl = canvas?.getContext?.('webgl2') ?? null;
    cached = !!gl;
    (gl as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { cached = false; }
  return cached;
}
