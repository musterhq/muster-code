/**
 * Muster Server (#199) serves this same renderer in a browser with a `window.muster` shim. These helpers let the few
 * desktop-only surfaces (built-in browser, terminals, screen capture, native previews) show a clear "desktop only" state,
 * and let the Server settings section reach the server's own commands. In the desktop app every helper is inert.
 */
export interface ServerUser { id: string; username: string; displayName: string; role: 'owner' | 'admin' | 'member' | 'viewer'; status: string; email?: string | null; lastLoginAt?: string | null; createdAt?: string }
export interface ServerBridge {
  ready: Promise<unknown>;
  info(): { user: ServerUser | null; server: { version: string; name: string } | null };
  invoke<T = unknown>(command: string, input?: Record<string, unknown>): Promise<T>;
  signOut(): Promise<void>;
}
type HostWindow = { muster?: { host?: string }; musterServer?: ServerBridge };
const host = (): HostWindow | null => typeof window === 'undefined' ? null : window as unknown as HostWindow;

/** True when this renderer runs in a browser against Muster Server. */
export const isWebHost = (): boolean => host()?.muster?.host === 'web';
export const serverBridge = (): ServerBridge | null => isWebHost() ? host()?.musterServer ?? null : null;
export const isServerAdmin = (): boolean => { const role = serverBridge()?.info().user?.role; return role === 'owner' || role === 'admin'; };
export const DESKTOP_ONLY_TITLE = 'Available in the Muster desktop app';
export function desktopOnlyText(feature: string): string { return `${feature} runs on your own computer, so it is available in the Muster desktop app, not in Muster Server’s web UI.`; }
/** `?project=<id>` from a desktop "Open" link (Settings › Integrations › Muster Server). */
export function requestedProject(): string | null {
  if (!isWebHost()) return null;
  try { return new URLSearchParams(window.location.search).get('project'); } catch { return null; }
}
