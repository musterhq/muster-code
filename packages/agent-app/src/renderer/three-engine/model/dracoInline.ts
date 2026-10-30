/**
 * Draco decoding inside the model worker.
 *
 * three's DRACOLoader spawns its own blob: Worker and fetches the decoder over the network, neither of which the
 * renderer's CSP (worker-src 'self', connect-src 'self') allows. This subclass keeps the loader's geometry assembly but
 * runs the vendored decoder (three/examples/jsm/libs/draco, Apache-2.0, wasm embedded in the worker chunk) directly in
 * the worker that is already off the main thread.
 */
import {DRACOLoader} from 'three/examples/jsm/loaders/DRACOLoader.js';
import dracoWrapper from './vendor/draco_wasm_wrapper.cjs';
import dracoWasm from 'three/examples/jsm/libs/draco/draco_decoder.wasm';

interface DracoModule { [key: string]: any }
let decoderPromise: Promise<DracoModule> | null = null;

function loadDecoder(): Promise<DracoModule> {
  decoderPromise ??= new Promise<DracoModule>((resolve, reject) => {
    try {
      const wasm = dracoWasm.buffer.slice(dracoWasm.byteOffset, dracoWasm.byteOffset + dracoWasm.byteLength);
      // The module object is thenable; hand it to resolve through a wrapper to avoid resolving a promise with itself.
      (dracoWrapper as any)({wasmBinary: wasm, onModuleLoaded: (draco: DracoModule) => resolve({draco} as any)});
    } catch (error) { reject(error); }
  }).then((box: any) => box.draco);
  return decoderPromise;
}

interface TaskConfig { attributeIDs: Record<string, number | string>; attributeTypes: Record<string, string>; useUniqueIDs: boolean; vertexColorSpace: string }
interface DecodedAttribute { name: string; count: number; itemSize: number; array: ArrayLike<number>; stride: number; vertexColorSpace?: string }
interface DecodedGeometry { index: {array: Uint32Array; itemSize: number} | null; attributes: DecodedAttribute[] }

type TypedArrayCtor = Float32ArrayConstructor | Int8ArrayConstructor | Int16ArrayConstructor | Int32ArrayConstructor | Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor;

function dataTypeOf(draco: DracoModule, ctor: TypedArrayCtor): number {
  switch (ctor) {
    case Float32Array: return draco.DT_FLOAT32;
    case Int8Array: return draco.DT_INT8;
    case Int16Array: return draco.DT_INT16;
    case Int32Array: return draco.DT_INT32;
    case Uint8Array: return draco.DT_UINT8;
    case Uint16Array: return draco.DT_UINT16;
    case Uint32Array: return draco.DT_UINT32;
  }
  throw new Error('Unsupported Draco attribute type.');
}

function decodeAttribute(draco: DracoModule, decoder: any, geometry: any, name: string, ctor: TypedArrayCtor, attribute: any): DecodedAttribute {
  const count = geometry.num_points(), itemSize = attribute.num_components();
  const srcStride = itemSize * ctor.BYTES_PER_ELEMENT, dstStride = Math.ceil(srcStride / 4) * 4;
  const ptr = draco._malloc(count * srcStride);
  decoder.GetAttributeDataArrayForAllPoints(geometry, attribute, dataTypeOf(draco, ctor), count * srcStride, ptr);
  const src = new ctor(draco.HEAPF32.buffer, ptr, (count * srcStride) / ctor.BYTES_PER_ELEMENT);
  let dst: InstanceType<TypedArrayCtor>;
  if (srcStride === dstStride) dst = src.slice();
  else {
    dst = new ctor((count * dstStride) / ctor.BYTES_PER_ELEMENT);
    const stride = dstStride / ctor.BYTES_PER_ELEMENT;
    for (let i = 0; i < count; i++) for (let j = 0; j < itemSize; j++) dst[i * stride + j] = src[i * itemSize + j]!;
  }
  draco._free(ptr);
  return {name, count, itemSize, array: dst, stride: dstStride / ctor.BYTES_PER_ELEMENT};
}

function decodeGeometry(draco: DracoModule, decoder: any, bytes: Int8Array, config: TaskConfig): DecodedGeometry {
  const type = decoder.GetEncodedGeometryType(bytes);
  let geometry: any, status: any;
  if (type === draco.TRIANGULAR_MESH) { geometry = new draco.Mesh(); status = decoder.DecodeArrayToMesh(bytes, bytes.byteLength, geometry); }
  else if (type === draco.POINT_CLOUD) { geometry = new draco.PointCloud(); status = decoder.DecodeArrayToPointCloud(bytes, bytes.byteLength, geometry); }
  else throw new Error('Draco: unexpected geometry type.');
  if (!status.ok() || geometry.ptr === 0) throw new Error(`Draco: decoding failed: ${status.error_msg()}`);
  const out: DecodedGeometry = {index: null, attributes: []};
  for (const name in config.attributeIDs) {
    const ctor = (globalThis as any)[config.attributeTypes[name]!] as TypedArrayCtor;
    let attribute: any;
    if (config.useUniqueIDs) attribute = decoder.GetAttributeByUniqueId(geometry, config.attributeIDs[name]);
    else {
      const id = decoder.GetAttributeId(geometry, draco[config.attributeIDs[name] as string]);
      if (id === -1) continue;
      attribute = decoder.GetAttribute(geometry, id);
    }
    const decoded = decodeAttribute(draco, decoder, geometry, name, ctor, attribute);
    if (name === 'color') decoded.vertexColorSpace = config.vertexColorSpace;
    out.attributes.push(decoded);
  }
  if (type === draco.TRIANGULAR_MESH) {
    const indices = geometry.num_faces() * 3, bytesLength = indices * 4;
    const ptr = draco._malloc(bytesLength);
    decoder.GetTrianglesUInt32Array(geometry, bytesLength, ptr);
    out.index = {array: new Uint32Array(draco.HEAPF32.buffer, ptr, indices).slice(), itemSize: 1};
    draco._free(ptr);
  }
  draco.destroy(geometry);
  return out;
}

export class InlineDracoLoader extends DRACOLoader {
  override preload(): this { return this; }
  override dispose(): this { return this; }
  // @ts-expect-error overriding a protected-by-convention method of DRACOLoader
  override async decodeGeometry(buffer: ArrayBuffer, taskConfig: TaskConfig) {
    const draco = await loadDecoder();
    const decoder = new draco.Decoder();
    try {
      const decoded = decodeGeometry(draco, decoder, new Int8Array(buffer), taskConfig);
      return (this as any)._createGeometry(decoded);
    } finally { draco.destroy(decoder); }
  }
}
