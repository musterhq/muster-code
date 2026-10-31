/** The local file a markdown image points at: `/abs/path.png` or `file:///abs/path.png`; undefined for anything else. */
export function localImagePath(src?: string): string | undefined {
  if (!src) return undefined;
  let path = src.trim();
  if (/^file:\/\//i.test(path)) { try { path = decodeURIComponent(new URL(path).pathname); } catch { return undefined; } }
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) return undefined;
  else { try { path = decodeURIComponent(path); } catch { /* keep as written */ } }
  return (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) && /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(path) ? path : undefined;
}
