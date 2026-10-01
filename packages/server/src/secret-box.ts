/**
 * Server secret box: AES-256-GCM with a 32-byte key from MUSTER_SERVER_SECRET_KEY (base64 or hex) or <dataDir>/keys/secret.key (0600).
 * It replaces Electron safeStorage for the agent runtime (provider keys, memory keys) and encrypts connector secrets in the server store.
 * Ciphertext layout: "msb1:" + base64(iv(12) | tag(16) | ciphertext).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServerStore } from './store/types.ts';

export interface SecretBox { isEncryptionAvailable(): boolean; encryptString(text: string): Buffer; decryptString(data: Buffer): string; getSelectedStorageBackend(): string }
const PREFIX = 'msb1:';

export function parseKey(raw: string): Buffer {
  const text = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('The server secret key must be 32 bytes (64 hex characters or base64).');
  return key;
}

/** Loads the key; creates it (0600, directory 0700) when `create` is set and none exists. */
export function loadSecretKey(file: string, env: NodeJS.ProcessEnv = process.env, create = true): { key: Buffer; source: 'env' | 'file' | 'created' } {
  if (env.MUSTER_SERVER_SECRET_KEY) return { key: parseKey(env.MUSTER_SERVER_SECRET_KEY), source: 'env' };
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o077;
    if (mode && process.platform !== 'win32') throw new Error(`${file} is readable by other users (mode ${(statSync(file).mode & 0o777).toString(8)}). Run: chmod 600 ${file}`);
    return { key: parseKey(readFileSync(file, 'utf8')), source: 'file' };
  }
  if (!create) throw new Error(`No server secret key at ${file}. Run muster-server init first.`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  try { chmodSync(file, 0o600); } catch { /* no modes */ }
  return { key, source: 'created' };
}

export function createSecretBox(key: Buffer): SecretBox {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'muster_server_aes_gcm',
    encryptString(text: string): Buffer {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.from(PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'));
    },
    decryptString(data: Buffer): string {
      const text = data.toString('utf8');
      if (!text.startsWith(PREFIX)) throw new Error('Not a Muster Server secret.');
      const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

const SECRET_ID = /^[A-Za-z0-9:_.-]{1,160}$/;
/** Connector and integration secrets, encrypted at rest in the server store. Config only ever holds the reference (id). */
export class ServerSecrets {
  constructor(private readonly store: ServerStore, private readonly box: SecretBox) {}
  async put(id: string, value: string): Promise<string> {
    if (!SECRET_ID.test(id)) throw new Error('Invalid secret reference.');
    if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error('Secret values must be 1 to 8192 characters.');
    await this.store.putSecret(id, this.box.encryptString(value.trim()).toString('utf8'), new Date().toISOString());
    return id;
  }
  async get(id: string): Promise<string | null> {
    const cipher = await this.store.secret(id);
    return cipher ? this.box.decryptString(Buffer.from(cipher, 'utf8')) : null;
  }
  async delete(id: string): Promise<void> { await this.store.deleteSecret(id); }
}
