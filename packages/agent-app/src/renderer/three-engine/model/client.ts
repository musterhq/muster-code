import {MAX_MODEL_BYTES, type ModelFormat} from './formats.ts';
import {ModelParseError, type ModelPayload} from './payload.ts';

export const MODEL_WORKER_NAME = 'muster-model';

export interface ParseHandle { promise: Promise<ModelPayload>; cancel(): void }

/**
 * Parse a model in a dedicated Web Worker. One worker per parse: it is terminated as soon as the result (or an error, or
 * a cancel) arrives, so an open/close cycle leaves no thread, no wasm instance and no decoded buffers behind.
 * `resolve` serves companion files; it must confine reads to the model's folder (the host command does).
 */
export function parseInWorker(
  request: {format: ModelFormat; path: string; bytes: ArrayBuffer},
  resolve: (path: string) => Promise<Uint8Array | null>,
  createWorker: () => Worker = () => new Worker(new URL('./model-worker.js', document.baseURI), {type: 'module', name: MODEL_WORKER_NAME}),
): ParseHandle {
  if (request.bytes.byteLength > MAX_MODEL_BYTES) {
    return {promise: Promise.reject(new ModelParseError('This 3D file is larger than the 128 MiB preview limit.', 'too-large')), cancel() {}};
  }
  let worker: Worker | null = null;
  let finish: (() => void) | null = null;
  const promise = new Promise<ModelPayload>((resolvePayload, reject) => {
    try { worker = createWorker(); } catch (error) { reject(new ModelParseError(`The 3D worker could not start: ${error instanceof Error ? error.message : error}`)); return; }
    const w = worker;
    const id = 1;
    finish = () => { finish = null; w.onmessage = null; w.onerror = null; w.terminate(); worker = null; };
    w.onmessage = (event: MessageEvent) => {
      const message = event.data as {type: string; id: number; reqId?: number; path?: string; payload?: ModelPayload; message?: string; code?: ModelParseError['code']};
      if (message.type === 'need') {
        void resolve(message.path!).then(
          bytes => w.postMessage({type: 'file', reqId: message.reqId, bytes}, bytes ? [bytes.buffer as ArrayBuffer] : []),
          () => w.postMessage({type: 'file', reqId: message.reqId, bytes: null}),
        );
      } else if (message.type === 'done') { finish?.(); resolvePayload(message.payload!); }
      else if (message.type === 'error') { finish?.(); reject(new ModelParseError(message.message ?? 'The model could not be read.', message.code ?? 'corrupt')); }
    };
    w.onerror = event => { event.preventDefault?.(); finish?.(); reject(new ModelParseError('The 3D parser stopped unexpectedly. The file may be too complex to preview.', 'corrupt')); };
    // Transfer the file's bytes: nothing is copied and the main thread keeps no second reference.
    w.postMessage({type: 'parse', id, format: request.format, path: request.path, bytes: request.bytes}, [request.bytes]);
  });
  return {promise, cancel: () => { finish?.(); }};
}
