/** Linux start-up choices that must be made before Electron is ready. */

const KNOWN_DESKTOPS = /gnome|unity|cinnamon|budgie|mate|pantheon|deepin|kde|plasma|lxqt|xfce/i;

/**
 * Chromium picks the password store from the desktop environment; on others (i3, sway, Hyprland, ...) it falls back
 * to a hard-coded key ("basic_text"), which is not real encryption. Any Secret Service provider (gnome-keyring,
 * KeePassXC, ...) answers gnome-libsecret, so ask for it there. undefined = leave Chromium's choice alone.
 */
export function passwordStoreSwitch(env: NodeJS.ProcessEnv, argv: readonly string[], platform: string = process.platform): string | undefined {
  if (platform !== 'linux') return undefined;
  if (argv.some(arg => arg.startsWith('--password-store'))) return undefined;
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ''}:${env.DESKTOP_SESSION ?? ''}`;
  return KNOWN_DESKTOPS.test(desktop) ? undefined : 'gnome-libsecret';
}
