import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderInfo } from '../shared/protocol.ts';

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
/** Only connection metadata is persisted. API keys stay in the host environment. */
export class CustomProviders {
  private db: DatabaseSync;
  private checks = new Map<string,AbortController>();
  private closed = false;
  constructor(dataDir: string, private env = process.env, private request: typeof fetch = fetch) {
    const file = join(dataDir, 'provider-connections.sqlite');
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, apiKeyEnv TEXT NOT NULL, models TEXT NOT NULL, checkedAt TEXT)');
  }
  private info(row: Connection): ProviderInfo {
    return {id: row.id, name: row.name, endpoint: row.endpoint, apiKeyEnv: row.apiKeyEnv, custom: true, available: false,
      status: 'configured', source: 'Added in Muster', identityMasked: 'No account metadata', canReveal: false,
      models: JSON.parse(row.models), ...(row.checkedAt ? {checkedAt: row.checkedAt} : {}),
      detail: row.checkedAt ? 'Model discovery succeeded. This connection is saved; chat execution for custom providers is not enabled yet.' : 'Saved locally. Check connection to discover models. Chat execution for custom providers is not enabled yet.'};
  }
  list(): ProviderInfo[] { return (this.db.prepare('SELECT * FROM connections ORDER BY name').all() as unknown as Connection[]).map(row => this.info(row)); }
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
    return this.list().find(row => row.id === id)!;
  }
  remove(id: string): void { this.cancel(id); this.db.prepare('DELETE FROM connections WHERE id=?').run(id); }
  cancel(id: string): void {this.checks.get(id)?.abort();}
  async check(id: string): Promise<ProviderInfo> {
    if (this.closed) throw new Error('Provider settings are closing.');
    if (this.checks.has(id)) throw new Error('This connection is already being checked.');
    if (this.checks.size >= 3) throw new Error('Wait for another connection check to finish.');
    const row = this.db.prepare('SELECT * FROM connections WHERE id=?').get(id) as Connection | undefined;
    if (!row) throw new Error('Connection not found.');
    const token = row.apiKeyEnv ? this.env[row.apiKeyEnv] : undefined;
    if (row.apiKeyEnv && !token) throw new Error('The configured API key environment variable is not available to Muster. Restart after setting it, then check again.');
    const endpoint = validateEndpoint(row.endpoint);
    const controller = new AbortController();
    this.checks.set(id,controller);
    const timer = setTimeout(()=>controller.abort(new Error('Connection check timed out.')),8000);
    try {
    let response: Response;
    try { response = await this.request(`${endpoint}/models`, {redirect:'error', signal:controller.signal, headers: token ? {Authorization: `Bearer ${token}`} : {}}); }
    catch { throw new Error(controller.signal.aborted ? 'Connection check cancelled or timed out. Saved settings were kept.' : 'Could not reach this endpoint. Check its URL and whether the service is running.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`The endpoint returned HTTP ${response.status}. Check the connection and its credentials.`); }
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
    return this.list().find(p=>p.id===id)!;
    } finally {clearTimeout(timer);if (this.checks.get(id) === controller) this.checks.delete(id);}
  }
  close():void {this.closed = true;for (const controller of this.checks.values()) controller.abort();this.db.close();}
}
