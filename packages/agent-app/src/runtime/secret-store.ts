/**
 * API keys entered in Muster. Values are encrypted with Electron safeStorage (Keychain-backed on macOS)
 * and written to dataDir/secrets.json as ciphertext only. Without OS encryption nothing is stored:
 * a plaintext fallback would silently downgrade the guarantee. Values never leave the runtime.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { electronSecretBox, type SecretBox } from './memory-context.ts';
import type { ProviderSecretStatus } from '../shared/domains/providers-protocol.ts';

interface Entry { cipher: string; updatedAt: string }
interface File { version: 1; secrets: Record<string, Entry> }
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const live: SecretStore[] = [];
/** The runtime's open store, so connection routing can resolve keys without another handle. */
export const activeSecretStore = (): SecretStore | undefined => live.at(-1);

export function validSecret(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter an API key.');
  const key = value.trim();
  if (!key) throw new Error('Enter an API key.');
  if (key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('That does not look like an API key. Paste the key without spaces or line breaks.');
  return key;
}

export class SecretStore {
  private readonly path: string;
  private file?: File;
  private readonly plain = new Map<string, string>();
  constructor(dataDir: string, private readonly box: () => SecretBox | undefined = electronSecretBox) {
    this.path = join(dataDir, 'secrets.json');
    live.push(this);
  }
  private read(): File {
    if (this.file) return this.file;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<File>;
      const secrets: Record<string, Entry> = {};
      for (const [id, entry] of Object.entries(raw?.secrets ?? {})) if (ID.test(id) && typeof entry?.cipher === 'string' && typeof entry.updatedAt === 'string') secrets[id] = {cipher: entry.cipher, updatedAt: entry.updatedAt};
      this.file = {version: 1, secrets};
    } catch { this.file = {version: 1, secrets: {}}; }
    return this.file;
  }
  private write(file: File): void {
    mkdirSync(join(this.path, '..'), {recursive: true});
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(file, null, 2), {mode: 0o600});
    renameSync(temp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* filesystems without modes */ }
    this.file = file;
  }
  secureStorage(): boolean { return Boolean(this.box()); }
  status(id: string): ProviderSecretStatus {
    const entry = ID.test(id) ? this.read().secrets[id] : undefined;
    return {stored: Boolean(entry), updatedAt: entry?.updatedAt ?? null, secureStorage: this.secureStorage()};
  }
  set(id: string, value: unknown): ProviderSecretStatus {
    if (!ID.test(id)) throw new Error('Invalid connection.');
    const key = validSecret(value), box = this.box();
    if (!box) throw new Error('Secure storage is unavailable on this Mac, so the key was not saved. Use an environment variable instead.');
    const current = this.read();
    this.write({version: 1, secrets: {...current.secrets, [id]: {cipher: box.encryptString(key).toString('base64'), updatedAt: new Date().toISOString()}}});
    this.plain.set(id, key);
    return this.status(id);
  }
  clear(id: string): ProviderSecretStatus {
    const current = this.read();
    this.plain.delete(id);
    if (current.secrets[id]) { const {[id]: _gone, ...rest} = current.secrets; this.write({version: 1, secrets: rest}); }
    return this.status(id);
  }
  /** Decrypted once per session and cached, so a run does not prompt the Keychain again. */
  get(id: string): string | undefined {
    const cached = this.plain.get(id);
    if (cached !== undefined) return cached;
    const entry = ID.test(id) ? this.read().secrets[id] : undefined, box = entry && this.box();
    if (!entry || !box) return undefined;
    try { const value = box.decryptString(Buffer.from(entry.cipher, 'base64')); this.plain.set(id, value); return value; } catch { return undefined; }
  }
  close(): void { const at = live.indexOf(this); if (at >= 0) live.splice(at, 1); this.plain.clear(); }
}
