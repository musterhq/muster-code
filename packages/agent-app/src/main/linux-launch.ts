/** Linux start-up choices that must be made before Electron is ready. */
import {spawnSync} from 'node:child_process';

/**
 * Desktops Chromium itself maps to a real store: GNOME, Cinnamon, Pantheon, Unity, XFCE, Deepin, UKUI and Budgie
 * (libsecret), KDE/Plasma (kwallet). MATE, LXQt, i3, sway, ... are NOT mapped and fall back to the hard-coded
 * "basic_text" key, so they must be told which store to use.
 */
const CHROMIUM_MAPPED = /gnome|unity|cinnamon|budgie|pantheon|deepin|ukui|xfce|kde|plasma/i;

export interface KeyringServices { secrets: boolean; kwallet5: boolean; kwallet6: boolean }

/** Session-bus names that are currently owned (a running keyring). Asks the bus with dbus-send, then busctl. */
export function runningKeyrings(run: (cmd: string, args: string[]) => string | undefined = defaultRun): KeyringServices {
  const names = run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames'])
    ?? run('busctl', ['--user', '--no-legend', 'list']) ?? '';
  const has = (name: string) => names.includes(name);
  return {secrets: has('org.freedesktop.secrets'), kwallet5: has('org.kde.kwalletd5'), kwallet6: has('org.kde.kwalletd6')};
}
function defaultRun(cmd: string, args: string[]): string | undefined {
  const result = spawnSync(cmd, args, {encoding: 'utf8', timeout: 1500});
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : undefined;
}

/**
 * Which --password-store to request. Chromium-mapped desktops keep Chromium's choice. Elsewhere ask for the keyring that
 * is actually running: a Secret Service (gnome-keyring, KeePassXC, ...) -> gnome-libsecret; else KWallet 6/5 when only
 * that runs; with nothing detected still gnome-libsecret (a keyring can be activated on demand; if none exists Electron
 * reports the backend as unusable and the app refuses to store secrets). undefined = leave Chromium's choice alone.
 */
export function passwordStoreSwitch(env: NodeJS.ProcessEnv, argv: readonly string[], platform: string = process.platform, keyrings: () => KeyringServices = runningKeyrings): string | undefined {
  if (platform !== 'linux') return undefined;
  if (argv.some(arg => arg.startsWith('--password-store'))) return undefined;
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ''}:${env.DESKTOP_SESSION ?? ''}`;
  if (CHROMIUM_MAPPED.test(desktop)) return undefined;
  const running = keyrings();
  if (!running.secrets && running.kwallet6) return 'kwallet6';
  if (!running.secrets && running.kwallet5) return 'kwallet5';
  return 'gnome-libsecret';
}
