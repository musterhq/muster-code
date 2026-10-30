/// <reference lib="webworker" />
/**
 * Model parsing worker: bytes in, ModelPayload out (geometry buffers and decoded textures are transferred, not copied).
 * Everything heavy lives here: format parsing, Draco/meshopt decompression, texture decoding, normal generation.
 *
 * Protocol (see client.ts):
 *   main -> worker  {type:'parse', id, format, path, bytes}   bytes transferred
 *   worker -> main  {type:'need', id, reqId, path}            a companion file is wanted
 *   main -> worker  {type:'file', reqId, bytes|null}
 *   worker -> main  {type:'done', id, payload} | {type:'error', id, message, code}
 */
import {parseModel} from './parse.ts';
import {ModelParseError, type CompanionResolver} from './payload.ts';
import {transferablesOf} from './serialize.ts';
import type {ModelFormat} from './formats.ts';

declare const self: DedicatedWorkerGlobalScope;

const waiting = new Map<number, (bytes: Uint8Array | null) => void>();
let nextRequest = 0;

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as {type: 'parse'; id: number; format: ModelFormat; path: string; bytes: ArrayBuffer} | {type: 'file'; reqId: number; bytes: Uint8Array | null};
  if (message.type === 'file') {
    waiting.get(message.reqId)?.(message.bytes);
    waiting.delete(message.reqId);
    return;
  }
  if (message.type !== 'parse') return;
  const resolve: CompanionResolver = path => new Promise(done => {
    const reqId = ++nextRequest;
    waiting.set(reqId, done);
    self.postMessage({type: 'need', id: message.id, reqId, path});
  });
  try {
    const payload = await parseModel({format: message.format, path: message.path, bytes: message.bytes}, resolve);
    self.postMessage({type: 'done', id: message.id, payload}, transferablesOf(payload));
  } catch (error) {
    const known = error instanceof ModelParseError;
    self.postMessage({type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error), code: known ? error.code : 'corrupt'});
  }
};
