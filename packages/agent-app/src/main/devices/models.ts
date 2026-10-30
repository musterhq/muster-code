/**
 * Realistic 3D device models (#363), downloaded on demand on the user's computer and never shipped by Muster.
 *
 * When a 3D view first needs one, main downloads Apple's public AR Quick Look file from apple.com, refuses it unless its
 * SHA-256 matches the pinned value, and keeps it under app data; the renderer converts it locally to a GLB
 * (renderer/devices/appleModels.ts) that is cached here too. Nothing Apple-derived is committed, bundled or uploaded.
 * The asset carries no open-source or redistribution licence; the cache metadata records its source and that fact.
 * Offline, or on any failure, the 3D view uses Muster's own parametric bodies. Turning the option off deletes the cache.
 *
 * Source URLs, checksums and node names follow the list in T3 Code's apps/web/src/components/device/models/sources.json
 * (MIT; see THIRD_PARTY_NOTICES.md). The models themselves are not taken from that project.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AppleModelSource {
  id: 'iphone' | 'ipad';
  label: string;
  url: string;
  sha256: string;
  /** USD prim names in Apple's file: the device body and its display mesh. */
  bodyNode: string;
  screenNode: string;
}
export const APPLE_MODELS: readonly AppleModelSource[] = [
  {id: 'iphone', label: 'iPhone', url: 'https://www.apple.com/105/media/us/iphone-18-pro/2026/591df885-5ee2-4173-86e6-401021249f7c/ar/iphone-18-pro-e-sim.usdz', sha256: '0f2dac354fbc6505e7917983de460f2cc68e253f96aabf52e9f0468a4803f317', bodyNode: 'UBGArkKGrAMRRnj', screenNode: 'EHjrGDHNHzgNjtE'},
  {id: 'ipad', label: 'iPad', url: 'https://www.apple.com/105/media/us/ipad-pro/2025/adee90db-c01e-430d-b726-fe64c0063f08/ar/ipad-pro-space-black.usdz', sha256: '48098daf7c49117c81a4e4e1808899b93fad081faeba6c8b65124946b83b5ac6', bodyNode: 'zRrSLDpdYmKeRJQ', screenNode: 'lsDiIbtoSGSmWWZ'},
];
/** Bumped when the local conversion changes, so older converted files are rebuilt. */
export const CONVERSION_VERSION = 2;
/** Recorded with every cached file: where it came from, and that it carries no licence. */
export const ASSET_AUTHOR = 'Apple Inc.', ASSET_LICENSE = 'No open-source or redistribution license has been established.';
const MAX_SOURCE_BYTES = 64 * 1024 * 1024, MAX_GLB_BYTES = 48 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['www.apple.com']);
export type ModelState = 'absent' | 'downloading' | 'ready' | 'converted' | 'failed';
export interface AppleModelStatus {id: AppleModelSource['id']; label: string; state: ModelState; error?: string}

export class AppleModels {
  private readonly dir: string;
  private pending = new Map<string, Promise<Buffer>>();
  private errors = new Map<string, string>();
  constructor(userData: string, private readonly fetchFn: typeof fetch, private readonly onChange: () => void = () => {}, private readonly models: readonly AppleModelSource[] = APPLE_MODELS) { this.dir = path.join(userData, 'device-models'); }
  private source(id: unknown): AppleModelSource {
    const found = this.models.find(model => model.id === id);
    if (!found) throw new Error('Unknown device model.');
    return found;
  }
  private sourceFile(model: AppleModelSource) { return path.join(this.dir, 'source', `${model.sha256}.usdz`); }
  private metaFile() { return path.join(this.dir, 'metadata.json'); }
  /** Where each cached model came from and its licence status, written next to the files. */
  private record(model: AppleModelSource, patch: Record<string, unknown>): void {
    let meta: {models?: Record<string, Record<string, unknown>>} = {};
    try { meta = JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')); } catch {}
    const models = meta.models ?? {};
    models[model.id] = {...models[model.id], sourceUrl: model.url, sourceSha256: model.sha256, author: ASSET_AUTHOR, assetLicense: ASSET_LICENSE, conversionVersion: CONVERSION_VERSION, ...patch};
    fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
    fs.writeFileSync(this.metaFile(), JSON.stringify({note: 'Downloaded on this computer from apple.com for the 3D device view; never redistributed.', models}, null, 2), {mode: 0o600});
  }
  private glbFile(model: AppleModelSource) { return path.join(this.dir, `${model.id}-${model.sha256.slice(0, 12)}-v${CONVERSION_VERSION}.glb`); }
  status(): AppleModelStatus[] {
    return this.models.map(model => ({id: model.id, label: model.label,
      state: fs.existsSync(this.glbFile(model)) ? 'converted' : this.pending.has(model.id) ? 'downloading' : fs.existsSync(this.sourceFile(model)) ? 'ready' : this.errors.has(model.id) ? 'failed' : 'absent',
      ...(this.errors.has(model.id) ? {error: this.errors.get(model.id)!} : {})}));
  }
  /** The converted GLB when cached, else the verified USDZ (downloaded now if needed) for the renderer to convert. */
  async get(id: unknown): Promise<{id: string; bodyNode: string; screenNode: string; glb?: Uint8Array; usdz?: Uint8Array}> {
    const model = this.source(id);
    const meta = {id: model.id, bodyNode: model.bodyNode, screenNode: model.screenNode};
    try { return {...meta, glb: new Uint8Array(fs.readFileSync(this.glbFile(model)))}; } catch {}
    return {...meta, usdz: new Uint8Array(await this.download(model))};
  }
  /** Downloads and verifies one model; concurrent callers share the request. */
  download(model: AppleModelSource): Promise<Buffer> {
    const cached = this.readVerified(model);
    if (cached) return Promise.resolve(cached);
    let pending = this.pending.get(model.id);
    if (!pending) {
      this.errors.delete(model.id);
      pending = this.fetchVerified(model)
        .then(buffer => { fs.mkdirSync(path.dirname(this.sourceFile(model)), {recursive: true, mode: 0o700}); fs.writeFileSync(this.sourceFile(model), buffer, {mode: 0o600}); this.record(model, {downloadedAt: new Date().toISOString()}); return buffer; })
        .catch(error => { this.errors.set(model.id, error instanceof Error ? error.message : String(error)); throw error; })
        .finally(() => { this.pending.delete(model.id); this.onChange(); });
      this.pending.set(model.id, pending);
      this.onChange();
    }
    return pending;
  }
  private readVerified(model: AppleModelSource): Buffer | null {
    try { const buffer = fs.readFileSync(this.sourceFile(model)); return sha256(buffer) === model.sha256 ? buffer : null; } catch { return null; }
  }
  private async fetchVerified(model: AppleModelSource): Promise<Buffer> {
    const url = new URL(model.url);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.host)) throw new Error('Device models are only downloaded from apple.com over HTTPS.');
    let response: Response;
    try { response = await this.fetchFn(url.href, {redirect: 'error', signal: AbortSignal.timeout(120_000)}); }
    catch { throw new Error(`Could not download the ${model.label} model from apple.com. Check your connection.`); }
    if (!response.ok || !response.body) throw new Error(`apple.com answered ${response.status} for the ${model.label} model.`);
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_SOURCE_BYTES) { await reader.cancel(); throw new Error(`The ${model.label} model is larger than expected, so it was not used.`); }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    if (sha256(buffer) !== model.sha256) throw new Error(`The ${model.label} model from apple.com did not match its expected checksum, so it was refused and Muster uses its own model.`);
    return buffer;
  }
  /** Caches a renderer-converted model. Only a binary glTF of sane size is accepted. */
  store(id: unknown, glb: unknown): void {
    const model = this.source(id);
    const bytes = glb instanceof Uint8Array ? Buffer.from(glb) : null;
    if (!bytes || bytes.length < 20 || bytes.length > MAX_GLB_BYTES || bytes.toString('latin1', 0, 4) !== 'glTF') throw new Error('Invalid converted model.');
    fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
    const file = this.glbFile(model), temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, bytes, {mode: 0o600});
    fs.renameSync(temp, file);
    this.record(model, {convertedAt: new Date().toISOString(), glb: path.basename(file)});
    this.onChange();
  }
  /** Turning the option off deletes every downloaded and converted Apple file. */
  clear(): void { fs.rmSync(this.dir, {recursive: true, force: true}); this.errors.clear(); this.onChange(); }
}
export const sha256 = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
