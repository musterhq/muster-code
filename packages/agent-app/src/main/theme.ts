import type {AppSettings, ThemePreference} from '../shared/domains/settings-protocol';

/** UX-19: keep Electron's nativeTheme (vibrancy material, native menus, dialogs, prefers-color-scheme in the
 *  renderer) in step with Settings > Appearance > Theme. The app ships dark; 'system' follows macOS. */
export interface ThemeTarget { themeSource: 'system' | 'dark' | 'light' }

export function themeFromSettingsResult(result: unknown): ThemePreference | undefined {
  const values = (result as {values?: Partial<AppSettings>} | null | undefined)?.values;
  const theme = values?.['appearance.theme'];
  return theme === 'system' || theme === 'dark' || theme === 'light' ? theme : undefined;
}

/** Returns true when the source changed. */
export function applyThemeSource(target: ThemeTarget, theme: ThemePreference | undefined): boolean {
  const next = theme ?? 'dark';
  if (target.themeSource === next) return false;
  target.themeSource = next;
  return true;
}

/** Solid window fill for platforms without vibrancy, matching --bg of the painted theme. */
export function windowBackground(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? '#181818' : '#fbfbfb';
}
