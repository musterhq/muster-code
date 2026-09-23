import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderInfo } from '../shared/protocol.ts';
import { registerProviderDataDir } from './provider-instances.ts';
import { activeSecretStore, type SecretStore } from './secret-store.ts';

export const CUSTOM_CHAT_ONLY = 'Chat only · no tools';
export interface CustomConnection { id: string; name: string; endpoint: string; apiKeyEnv: string; models: {id:string;name:string}[]; checkedAt: string | null }
/** The key for a connection: the one entered in Muster (Keychain-encrypted) first, then its environment variable. */
export const resolveCustomKey = (row: Pick<CustomConnection,'id'|'apiKeyEnv'>, env: NodeJS.ProcessEnv, secrets: SecretStore | undefined = activeSecretStore()): string | undefined =>
  secrets?.get(row.id) ?? (row.apiKeyEnv ? env[row.apiKeyEnv] || undefined : undefined);
const keyRequired = (row: Pick<CustomConnection,'id'|'apiKeyEnv'>, secrets = activeSecretStore()) => Boolean(row.apiKeyEnv || secrets?.status(row.id).stored);
/** Runnable once model discovery succeeded and its key (stored in Muster or a visible variable), if any, resolves. */
export const customRunnable = (row: CustomConnection, env: NodeJS.ProcessEnv): boolean => Boolean(row.checkedAt && row.models.length && (!keyRequired(row) || resolveCustomKey(row, env)));
/** The runtime's open connection store, so the provider adapter can route custom ids without another database handle. */
const live: CustomProviders[] = [];
export const activeCustomProviders = (): CustomProviders | undefined => live.at(-1);

interface Connection { id: string; name: string; endpoint: string; apiKeyEnv: string; models: string; checkedAt: string | null }
export function validateEndpoint(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Enter a valid API base URL.');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Enter a valid API base URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Use a base URL without credentials, query parameters or fragments.');
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Use HTTPS, or HTTP for a local loopback server.');
  return url.href.replace(/\/+$/, '');
}
/** Only connection metadata is persisted here. Keys live in the host environment or, entered in Muster, in secret-store.ts. */
export class CustomProviders {
  private db: DatabaseSync;
  private checks = new Map<string,AbortController>();
  private closed = false;
  constructor(readonly dataDir: string, private env = process.env, private request: typeof fetch = fetch) {
    const file = join(dataDir, 'provider-connections.sqlite');
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    live.push(this); registerProviderDataDir(dataDir);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, apiKeyEnv TEXT NOT NULL, models TEXT NOT NULL, checkedAt TEXT)');
  }
  private claimed = false;
  private info(row: Connection): ProviderInfo {
    const connection = this.connection(row), runnable = customRunnable(connection, this.env);
    const keyMissing = keyRequired(row) && !resolveCustomKey(row, this.env);
    return {id: row.id, name: row.name, endpoint: row.endpoint, apiKeyEnv: row.apiKeyEnv, custom: true, available: runnable,
      status: runnable ? 'ready' : 'configured', source: 'Added in Muster', identityMasked: 'No account metadata', canReveal: false,
      models: connection.models, ...(row.checkedAt ? {checkedAt: row.checkedAt} : {}),
      detail: runnable ? `${CUSTOM_CHAT_ONLY}. OpenAI-compatible chat completions; model discovery succeeded.`
        : keyMissing ? row.apiKeyEnv ? `${row.apiKeyEnv} is not set in Muster’s environment. Paste the key below, or export it in your shell profile and restart Muster.` : 'The stored API key could not be read from the Keychain. Paste it again.'
        : row.checkedAt ? 'Model discovery found no models. Check the endpoint and try again.'
        : `Saved locally. Check connection to discover models; it becomes available to chats (${CUSTOM_CHAT_ONLY.toLowerCase()}) once models are found.`};
  }
  private connection(row: Connection): CustomConnection { let models: CustomConnection['models'] = []; try { models = JSON.parse(row.models); } catch { models = []; } return {...row, models}; }
  private rows(): ProviderInfo[] { return (this.db.prepare('SELECT * FROM connections ORDER BY name').all() as unknown as Connection[]).map(row => this.info(row)); }
  /** Every saved connection with its model catalog; the provider adapter routes the runnable ones. */
  connections(): CustomConnection[] { if (this.closed) return []; return (this.db.prepare('SELECT * FROM connections ORDER BY name').all() as unknown as Connection[]).map(row => this.connection(row)); }
  /** Called by the provider adapter that lists runnable connections itself, so list() does not repeat them. */
  claim(): void { this.claimed = true; }
  list(): ProviderInfo[] { const rows = this.rows(); return this.claimed ? rows.filter(row => !row.available) : rows; }
  save(input: {id?:unknown;name: unknown; endpoint: unknown; apiKeyEnv?: unknown}): ProviderInfo {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f]/.test(input.name)) throw new Error('Enter a provider name (up to 100 characters).');
    const endpoint = validateEndpoint(input.endpoint);
    const apiKeyEnv = input.apiKeyEnv ?? '';
    if (typeof apiKeyEnv !== 'string' || (apiKeyEnv && !/^[A-Z][A-Z0-9_]{1,127}$/.test(apiKeyEnv))) throw new Error('Enter an environment variable name, not the API key itself.');
    const id = input.id === undefined ? `custom_${randomUUID()}` : input.id;
    if (typeof id !== 'string' || !/^custom_[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid connection.');
    if (input.id !== undefined && !this.db.prepare('SELECT id FROM connections WHERE id=?').get(id)) throw new Error('Connection no longer exists.');
    this.cancel(id);
    try {
      if (input.id === undefined) this.db.prepare('INSERT INTO connections VALUES (?,?,?,?,?,NULL)').run(id, input.name.trim(), endpoint, apiKeyEnv, '[]');
      else this.db.prepare('UPDATE connections SET name=?,endpoint=?,apiKeyEnv=?,models=CASE WHEN endpoint=? AND apiKeyEnv=? THEN models ELSE ? END,checkedAt=CASE WHEN endpoint=? AND apiKeyEnv=? THEN checkedAt ELSE NULL END WHERE id=?').run(input.name.trim(),endpoint,apiKeyEnv,endpoint,apiKeyEnv,'[]',endpoint,apiKeyEnv,id);
    }
    catch (error) { if (String(error).includes('UNIQUE')) throw new Error('That endpoint is already configured.'); throw new Error('Could not save this connection.'); }
    return this.rows().find(row => row.id === id)!;
  }
  remove(id: string): void { this.cancel(id); this.db.prepare('DELETE FROM connections WHERE id=?').run(id); activeSecretStore()?.clear(id); }
  has(id: string): boolean { return !this.closed && Boolean(this.db.prepare('SELECT id FROM connections WHERE id=?').get(id)); }
  cancel(id: string): void {this.checks.get(id)?.abort();}
  async check(id: string): Promise<ProviderInfo> {
    if (this.closed) throw new Error('Provider settings are closing.');
    if (this.checks.has(id)) throw new Error('This connection is already being checked.');
    if (this.checks.size >= 3) throw new Error('Wait for another connection check to finish.');
    const row = this.db.prepare('SELECT * FROM connections WHERE id=?').get(id) as Connection | undefined;
    if (!row) throw new Error('Connection not found.');
    const token = resolveCustomKey(row, this.env);
    if (keyRequired(row) && !token) throw new Error(row.apiKeyEnv ? `${row.apiKeyEnv} is not available to Muster. Paste the key in Muster, or export it in your shell profile and restart.` : 'The stored API key could not be read from the Keychain. Paste it again.');
    const endpoint = validateEndpoint(row.endpoint);
    const controller = new AbortController();
    this.checks.set(id,controller);
    const timer = setTimeout(()=>controller.abort(new Error('Connection check timed out.')),8000);
    try {
    let response: Response;
    try { response = await this.request(`${endpoint}/models`, {redirect:'error', signal:controller.signal, headers: token ? {Authorization: `Bearer ${token}`} : {}}); }
    catch { throw new Error(controller.signal.aborted ? 'Connection check cancelled or timed out. Saved settings were kept.' : 'Could not reach this endpoint. Check its URL and whether the service is running.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? `The endpoint rejected the API key (HTTP ${response.status}). Paste a valid key and check again.` : `The endpoint returned HTTP ${response.status}. Check the connection and its credentials.`); }
    // Stream with a hard cap: an untrusted endpoint cannot consume unbounded RAM.
    let raw = ''; let bytes = 0; const reader = response.body?.getReader(); const decoder = new TextDecoder();
    if (reader) try { for (;;) { const {done,value} = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1024*1024) throw new Error('Model catalog is too large.'); raw += decoder.decode(value,{stream:true}); } raw += decoder.decode(); }
    finally { await reader.cancel().catch(() => {}); }
    let data: unknown; try { data = JSON.parse(raw); } catch { throw new Error('The endpoint did not return a valid model catalog.'); }
    const items = (data as {data?: unknown})?.data;
    if (!Array.isArray(items)) throw new Error('The endpoint did not return an OpenAI-compatible model catalog.');
    const models = items.slice(0,500).filter(m => m && typeof m.id === 'string' && m.id.length <= 200 && !/[\x00-\x1f]/.test(m.id)).map(m => ({id:m.id,name:m.id}));
    if (controller.signal.aborted || this.closed) throw new Error('Connection check cancelled. Saved settings were kept.');
    const changed = this.db.prepare('UPDATE connections SET models=?,checkedAt=? WHERE id=? AND endpoint=? AND apiKeyEnv=?').run(JSON.stringify(models),new Date().toISOString(),id,endpoint,row.apiKeyEnv);
    if (!changed.changes) throw new Error('Connection changed during discovery. Check the updated connection again.');
    return this.rows().find(p=>p.id===id)!;
    } finally {clearTimeout(timer);if (this.checks.get(id) === controller) this.checks.delete(id);}
  }
  close():void {if (this.closed) return;this.closed = true;const at = live.indexOf(this);if (at >= 0) live.splice(at,1);if (!live.length) registerProviderDataDir(undefined);else registerProviderDataDir(live.at(-1)!.dataDir);for (const controller of this.checks.values()) controller.abort();this.db.close();}
}
