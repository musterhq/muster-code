import type {AppSettings, SendKey, ThemePreference} from '../../../shared/domains/settings-protocol';

/** The theme actually painted: 'system' follows the OS (main sets nativeTheme.themeSource to match, so
 *  prefers-color-scheme reports the real macOS appearance). */
export function resolveTheme(preference: ThemePreference | undefined, prefersLight = systemPrefersLight()): 'dark' | 'light' {
  if (preference === 'light' || preference === 'dark') return preference;
  if (preference === 'system') return prefersLight ? 'light' : 'dark';
  return 'dark';
}
function systemPrefersLight(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches; } catch { return false; }
}
/** Re-resolve 'system' when macOS flips appearance. */
export function installSystemThemeListener(preference: () => ThemePreference | undefined, root: HTMLElement = document.documentElement): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia('(prefers-color-scheme: light)');
  const onChange = () => { if (preference() === 'system') root.setAttribute('data-theme', resolveTheme('system', query.matches)); };
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
}

/** Document-level preferences: CSS keys off these attributes; the composer inherits spellcheck from <html>. */
export function applyDocumentPreferences(settings: AppSettings, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', resolveTheme(settings['appearance.theme']));
  root.setAttribute('data-motion', settings['appearance.reducedMotion']);
  root.setAttribute('data-transparency', settings['appearance.reducedTransparency']);
  root.setAttribute('data-send-key', settings['general.sendKey']);
  root.setAttribute('spellcheck', String(settings['general.spellcheck']));
}

export interface SendKeyEvent { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number }

/** With ⌘Enter to send, a bare Enter in the message field types a new line instead of reaching the composer's send handler.
 *  An open suggestion list (aria-expanded) still takes Enter to pick. */
export function enterTypesNewline(mode: SendKey, event: SendKeyEvent, target: {matches?(selector: string): boolean; getAttribute?(name: string): string | null} | null): boolean {
  if (mode !== 'mod-enter' || event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (!target?.matches?.('textarea.composer-input') || target.getAttribute?.('aria-expanded') === 'true') return false;
  return true;
}

/** Capture-phase guard: stopping propagation keeps React's handler from sending while the browser still inserts the newline. */
export function installSendKey(mode: () => SendKey): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (enterTypesNewline(mode(), event, event.target as Element | null)) event.stopPropagation();
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
