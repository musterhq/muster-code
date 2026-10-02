/**
 * The one stored connection to "the server" (Settings › Integrations › Muster Server), in `server.json`.
 *
 * Migration: two older files fed this. `paperclip.json` (mode, URL, company, the origin its token was saved for) and `muster-server.json`
 * (URL, token origin, who signed in). They are read once, when `server.json` does not exist yet, and written into it. Tokens are never
 * copied or re-encrypted: the config records which secret-store entry holds the token (`tokenSecret`), so a person who was linked
 * before keeps working with no re-auth and the token stays bound to the origin it was issued for. The old files are left untouched
 * (a downgrade still finds them). If both were in use, the linked Paperclip wins (it fed the in-app views); the other token stays in the keychain.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaperclipMode, ServerBackendKind } from '../../shared/domains/paperclip-protocol.ts';
import { PAPERCLIP_LOCAL_URL } from '../../shared/domains/paperclip-protocol.ts';

export const LEGACY_PAPERCLIP_SECRET = 'paperclip-board-token';
export const LEGACY_MUSTER_SERVER_SECRET = 'muster-server-token';
export const SERVER_SECRET = 'server-token';
/** The hosted-server browser session (the Cookie its live socket accepts), kept encrypted and bound to `sessionOrigin`. */
export const SESSION_SECRET = 'server-session';
export interface ServerUser { username: string; displayName: string; role: string }
export interface ServerConfig {
  version: 2; mode: PaperclipMode; baseUrl: string; companyId: string | null;
  /** Detected from the URL; null until it has been (then the next read detects it). */
  backend: ServerBackendKind | null;
  /** The origin the stored token was issued for: the token is sent there and nowhere else. */
  tokenOrigin: string | null;
  /** Which secret-store entry holds the token (a migrated one keeps its old entry, so nobody signs in again). */
  tokenSecret: string;
  /** A password sign-in's account (Muster Server). */
  user: ServerUser | null; serverVersion: string | null; connectedAt: string | null;
  /** A browser-approval sign-in's account, and why a sign-in ended on its own (until the next one). */
  signedIn: { name: string | null; email: string | null } | null; signInNotice: string | null;
  /** The origin the stored session cookie belongs to (the cookie is sent there and nowhere else). */
  sessionOrigin: string | null;
  migratedFrom?: string[];
}
export const DEFAULT_SERVER_CONFIG: ServerConfig = { version: 2, mode: 'off', baseUrl: PAPERCLIP_LOCAL_URL, companyId: null, backend: null, tokenOrigin: null, tokenSecret: SERVER_SECRET, user: null, serverVersion: null, connectedAt: null, signedIn: null, signInNotice: null, sessionOrigin: null };

const who = (v: unknown): { name: string | null; email: string | null } | null => v && typeof v === 'object' ? { name: s((v as Record<string, unknown>).name), email: s((v as Record<string, unknown>).email) } : null;
const read = (path: string): Record<string, unknown> | null => { try { const v = JSON.parse(readFileSync(path, 'utf8')) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; } };
const s = (v: unknown): string | null => typeof v === 'string' && v ? v : null;

/** Reads `server.json`, or builds it from the older files (writing it so that this happens once). */
export function loadServerConfig(dataDir: string): { config: ServerConfig; migrated: boolean } {
  const file = join(dataDir, 'server.json');
  const own = read(file);
  if (own && own.version === 2) {
    const mode = own.mode === 'local' || own.mode === 'custom' ? own.mode : 'off';
    const user = own.user && typeof own.user === 'object' ? own.user as ServerUser : null;
    return { migrated: false, config: { ...DEFAULT_SERVER_CONFIG, mode, baseUrl: s(own.baseUrl) ?? PAPERCLIP_LOCAL_URL, companyId: s(own.companyId), backend: own.backend === 'paperclip' || own.backend === 'muster-server' ? own.backend : null,
      tokenOrigin: s(own.tokenOrigin), tokenSecret: s(own.tokenSecret) ?? SERVER_SECRET, user, serverVersion: s(own.serverVersion), connectedAt: s(own.connectedAt), signedIn: who(own.signedIn), signInNotice: s(own.signInNotice), sessionOrigin: s(own.sessionOrigin), ...(Array.isArray(own.migratedFrom) ? { migratedFrom: own.migratedFrom as string[] } : {}) } };
  }
  const paperclip = read(join(dataDir, 'paperclip.json')), muster = read(join(dataDir, 'muster-server.json'));
  const pcMode = paperclip?.mode === 'local' || paperclip?.mode === 'custom' ? paperclip.mode : 'off';
  const musterLinked = Boolean(muster && s(muster.url) && s(muster.tokenOrigin));
  let config: ServerConfig = { ...DEFAULT_SERVER_CONFIG };
  const from: string[] = [];
  if (paperclip && (pcMode !== 'off' || !musterLinked)) {
    config = { ...config, mode: pcMode, baseUrl: s(paperclip.baseUrl) ?? PAPERCLIP_LOCAL_URL, companyId: s(paperclip.companyId), backend: 'paperclip', tokenOrigin: s(paperclip.tokenOrigin), tokenSecret: LEGACY_PAPERCLIP_SECRET, signedIn: who(paperclip.signedIn), signInNotice: s(paperclip.signInNotice) };
    from.push('paperclip.json');
  } else if (muster && musterLinked) {
    const user = muster.user && typeof muster.user === 'object' ? muster.user as ServerUser : null;
    config = { ...config, mode: 'custom', baseUrl: s(muster.url)!, backend: 'muster-server', tokenOrigin: s(muster.tokenOrigin), tokenSecret: LEGACY_MUSTER_SERVER_SECRET, user, serverVersion: s(muster.serverVersion), connectedAt: s(muster.connectedAt) };
    from.push('muster-server.json');
  }
  if (!from.length) return { config, migrated: false };
  config.migratedFrom = from;
  try { saveServerConfig(dataDir, config); } catch { /* read-only data dir: the in-memory config still works */ }
  return { config, migrated: true };
}

export function saveServerConfig(dataDir: string, config: ServerConfig): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'server.json'), temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
export const hasServerConfig = (dataDir: string) => existsSync(join(dataDir, 'server.json'));
