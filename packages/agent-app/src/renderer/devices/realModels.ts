/**
 * Realistic 3D device models (#363) for the renderer: which frames have one, fetching the cached conversion or the
 * verified apple.com download from main, converting it here once, and caching the result. Any failure (offline,
 * checksum refused, option off, an unexpected file) returns null and the 3D view keeps Muster's own body.
 */
import type {Group} from 'three';
import type {FrameSpec} from '../../shared/device-frames.ts';
import type {DeviceCommands} from '../../shared/device-protocol.ts';

/** Only frames whose real device matches the available models (iPhone with Dynamic Island, iPad without Home button). */
export const realModelFor = (spec: Pick<FrameSpec, 'id'>): 'iphone' | 'ipad' | null => spec.id === 'iphone-island' ? 'iphone' : spec.id === 'ipad' ? 'ipad' : null;
type Invoke = <K extends 'devices.model' | 'devices.modelStore'>(command: K, input: DeviceCommands[K]['input']) => Promise<DeviceCommands[K]['output']>;
const glbs = new Map<string, Promise<Uint8Array | null>>();

/** The model's GLB bytes, converting a fresh download once; null on any failure (never throws). */
export function realModelGlb(id: 'iphone' | 'ipad', invoke: Invoke, convert: (usdz: Uint8Array, body: string, screen: string) => Promise<ArrayBuffer>): Promise<Uint8Array | null> {
  let pending = glbs.get(id);
  if (!pending) {
    pending = (async () => {
      const result = await invoke('devices.model', {id});
      if (result.glb) return result.glb;
      if (!result.usdz) return null;
      const glb = new Uint8Array(await convert(result.usdz, result.bodyNode, result.screenNode));
      await invoke('devices.modelStore', {id, glb});
      return glb;
    })().catch(error => { console.warn(`Realistic ${id} model unavailable, using Muster's own body:`, error instanceof Error ? error.message : error); return null; });
    glbs.set(id, pending);
    // A failure is not remembered: the next 3D view tries again (it may be online by then).
    void pending.then(value => { if (!value) glbs.delete(id); });
  }
  return pending;
}
export const resetRealModels = () => glbs.clear();
/** The one-time note shown while the first model downloads. */
export const MODELS_NOTE = 'Downloads device models from apple.com';
export function takeModelsNote(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined): boolean {
  try { if (!storage || storage.getItem('muster.deviceModelsNote') === '1') return false; storage.setItem('muster.deviceModelsNote', '1'); return true; } catch { return false; }
}
export type {Group};
