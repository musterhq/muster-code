/** #324: runs synchronously from <head>, before the stylesheet is first painted, so a chosen colour theme never flashes
 *  the stock one. It only reads the cache that applyColorTheme wrote (re-validated), and does nothing when none exists:
 *  a user who never picked a theme sees the page exactly as the stylesheet paints it. */
import {BOOT_CACHE_KEY, applyThemeTokens, parseBootCache, pickTheme} from '../shared/theme.ts';

export function applyBootTheme(root: HTMLElement, storage: Pick<Storage, 'getItem'> | null, prefersLight: boolean): boolean {
  let text: string | null = null;
  try { text = storage?.getItem(BOOT_CACHE_KEY) ?? null; } catch { return false; }
  const cache = parseBootCache(text);
  if (!cache) return false;
  const mode = cache.preference === 'system' ? (prefersLight ? 'light' : 'dark') : cache.preference;
  const theme = mode === 'light' ? (cache.light ?? pickTheme('light', undefined, undefined)) : (cache.dark ?? pickTheme('dark', undefined, undefined));
  root.setAttribute('data-theme', mode);
  applyThemeTokens(root, theme);
  return true;
}

if (typeof document !== 'undefined') {
  try {
    let light = false;
    try { light = matchMedia('(prefers-color-scheme: light)').matches; } catch { /* default dark */ }
    let storage: Storage | null = null;
    try { storage = localStorage; } catch { /* blocked */ }
    applyBootTheme(document.documentElement, storage, light);
  } catch { /* never block startup */ }
}
