/**
 * BRW-06: the in-app browser's restorable session state (each tab's back/forward stack, with URLs that can carry
 * OAuth codes or tokens and Chromium page state that can hold form fields) persisted across restarts, encrypted at
 * rest with Electron safeStorage (Keychain-backed on macOS). Cookies and site storage stay in Chromium's own
 * per-profile partition. Without OS encryption nothing is written: a plaintext fallback would silently downgrade
 * the guarantee. A file that no longer decrypts (Keychain reset, copied from another Mac) is dropped and reported
 * once so the tab can say "sign in again" instead of failing silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {SavedBrowserHistory} from './browser-workspace.ts';

export interface SessionBox {isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string}
export interface SavedBrowserSession {owner: string; profileId: string; url: string; title: string; history?: SavedBrowserHistory; savedAt: number}
export type BrowserVaultStatus = 'empty' | 'encrypted' | 'unavailable' | 'unreadable';
export const MAX_VAULT_SESSIONS = 16;
/** Saved sessions older than this are not restored (the sign-in behind them has usually expired anyway). */
export const VAULT_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_VAULT_BYTES = 8 * 1024 * 1024;
const OWNER = /^browser:[a-zA-Z0-9_-]{1,128}$/, PROFILE = /^[a-zA-Z0-9_-]{1,64}$/;

function valid(value: unknown, now: number): SavedBrowserSession | undefined {
  const row = value as Partial<SavedBrowserSession> | null;
  if (!row || typeof row.owner !== 'string' || !OWNER.test(row.owner) || typeof row.profileId !== 'string' || !PROFILE.test(row.profileId)) return undefined;
  if (typeof row.url !== 'string' || row.url.length > 8192 || typeof row.savedAt !== 'number' || now - row.savedAt > VAULT_TTL_MS) return undefined;
  const history = row.history && Array.isArray(row.history.entries) && typeof row.history.index === 'number' ? row.history : undefined;
  return {owner: row.owner, profileId: row.profileId, url: row.url, title: typeof row.title === 'string' ? row.title.slice(0, 512) : '', ...(history ? {history} : {}), savedAt: row.savedAt};
}

export class BrowserSessionVault {
  private sessions?: Map<string, SavedBrowserSession>;
  private state: BrowserVaultStatus = 'empty';
  private unreadableNotice = false;
  /** Taken by an open tab but still on disk until the next save. */
  private taken = new Set<string>();
  constructor(private readonly file: string, private readonly box: () => SessionBox | undefined, private readonly now: () => number = Date.now) {}
  private secure(): SessionBox | undefined {
    try { const box = this.box(); return box?.isEncryptionAvailable() ? box : undefined; } catch { return undefined; }
  }
  private load(): Map<string, SavedBrowserSession> {
    if (this.sessions) return this.sessions;
    this.sessions = new Map();
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { this.state = this.secure() ? 'empty' : 'unavailable'; return this.sessions; }
    const box = this.secure();
    try {
      if (raw.length > MAX_VAULT_BYTES) throw new Error('too large');
      const envelope = JSON.parse(raw) as {version?: unknown; cipher?: unknown};
      if (envelope.version !== 1 || typeof envelope.cipher !== 'string') throw new Error('not a vault');
      if (!box) { this.state = 'unavailable'; return this.sessions; }
      const rows = JSON.parse(box.decryptString(Buffer.from(envelope.cipher, 'base64'))) as unknown;
      if (!Array.isArray(rows)) throw new Error('not a list');
      const now = this.now();
      for (const row of rows.slice(0, MAX_VAULT_SESSIONS)) { const session = valid(row, now); if (session) this.sessions.set(session.owner, session); }
      this.state = 'encrypted';
    } catch {
      this.state = 'unreadable'; this.unreadableNotice = true;
      try { fs.rmSync(this.file, {force: true}); } catch { /* next save replaces it */ }
    }
    return this.sessions;
  }
  status(): BrowserVaultStatus { this.load(); return this.state; }
  /** True once after a vault failed to decrypt: the first restored tab tells the user to sign in again. */
  consumeUnreadableNotice(): boolean { this.load(); const value = this.unreadableNotice; this.unreadableNotice = false; return value; }
  /** One-shot: a restored tab owns its state from then on (the next save writes it again if still open). */
  take(owner: string, profileId: string): SavedBrowserSession | undefined {
    const sessions = this.load(), session = sessions.get(owner);
    if (!session) return undefined;
    sessions.delete(owner); this.taken.add(owner);
    return session.profileId === profileId ? session : undefined;
  }
  /** Replaces the saved set. Returns false (and removes any old file) when OS encryption is unavailable. */
  save(sessions: readonly SavedBrowserSession[]): boolean {
    const box = this.secure();
    const merged = new Map(this.load());
    for (const session of sessions) { const checked = valid(session, this.now()); if (checked) merged.set(checked.owner, checked); }
    const rows = [...merged.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_VAULT_SESSIONS);
    if (!box) { this.state = 'unavailable'; try { fs.rmSync(this.file, {force: true}); } catch {} return false; }
    if (!rows.length) { try { fs.rmSync(this.file, {force: true}); } catch {} this.state = 'empty'; return true; }
    const cipher = box.encryptString(JSON.stringify(rows)).toString('base64');
    fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({version: 1, cipher}), {mode: 0o600});
    fs.renameSync(temp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* filesystems without modes */ }
    this.sessions = new Map(rows.map(row => [row.owner, row]));
    this.taken.clear();
    this.state = 'encrypted';
    return true;
  }
  forget(owner: string): void { const removed = this.load().delete(owner); if (this.taken.delete(owner) || removed) this.rewrite(); }
  forgetProfile(profileId: string): void {
    const sessions = this.load(); let removed = false;
    for (const [owner, session] of sessions) if (session.profileId === profileId) { sessions.delete(owner); removed = true; }
    if (removed) this.rewrite();
  }
  private rewrite(): void { try { this.save([]); } catch { /* best effort; stale rows expire */ } }
}
