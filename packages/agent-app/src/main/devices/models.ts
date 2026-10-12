/**
 * Apple device models for the 3D view (#363), fetched on the user's own computer, never shipped by Muster.
 *
 * Muster does not commit, bundle or redistribute any Apple-derived 3D asset. Only when the user turns on "Apple device
 * models" in Settings › Integrations › Devices does main download Apple's public AR Quick Look files below from
 * apple.com, check each against its pinned SHA-256, and keep it under app data. The renderer converts it locally (see
 * renderer/devices/appleModels.ts: body and screen nodes extracted, the screen replaced by the live-texture placeholder,
 * axes and scale normalised, textures capped at 1024 px) and hands the result back here to cache. Any failure, or being
 * offline, falls back to Muster's own procedural bodies. Android always uses Muster's own bodies.
 *
 * Provenance: URLs and checksums cross-checked against T3 Code's apps/web/src/components/device/models/sources.json
 * (MIT code; it states no redistribution licence for the Apple assets themselves, which is why we download instead).
 * Re-verified 2026-10-12: both URLs answered 200 and matched the checksums below.
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
export const CONVERSION_VERSION = 1;
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
        .then(buffer => { fs.mkdirSync(path.dirname(this.sourceFile(model)), {recursive: true, mode: 0o700}); fs.writeFileSync(this.sourceFile(model), buffer, {mode: 0o600}); return buffer; })
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
    if (sha256(buffer) !== model.sha256) throw new Error(`The ${model.label} model from apple.com changed (checksum mismatch), so Muster uses its own model.`);
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
    this.onChange();
  }
  /** Turning the option off deletes every downloaded and converted Apple file. */
  clear(): void { fs.rmSync(this.dir, {recursive: true, force: true}); this.errors.clear(); this.onChange(); }
}
export const sha256 = (buffer: Uint8Array) => createHash('sha256').update(buffer).digest('hex');
