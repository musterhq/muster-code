import {computeDiffModel, hashRevision} from './diffModel';

/**
 * Request-id protocol: `{id,before,after,ignoreWhitespace}` answers with
 * `{id,...model}` or `{id,error}`; `{id,cancel:true}` drops a request that has
 * not started. Requests are queued and the loop yields to the event queue
 * before each one so a cancel posted right after a request still wins.
 */
export type DiffWorkerRequest = {id:number;before:string;after:string;ignoreWhitespace?:boolean} | {id:number;cancel:true};
const scope = globalThis as unknown as {onmessage:((event:MessageEvent)=>void)|null;postMessage:(message:unknown)=>void};
const queue: Extract<DiffWorkerRequest,{before:string}>[] = [];
const cancelled = new Set<number>();
let draining = false;
/** The request being computed; only it can be cancelled mid-flight (ids already answered are never tracked). */
let active: number | undefined;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
      // A cancel during the yield may have emptied the queue.
      const request = queue.shift();
      if (!request) break;
      active = request.id;
      try {
        const model = computeDiffModel(request.before, request.after, request.ignoreWhitespace);
        const revision = await hashRevision(request.before, request.after);
        if (cancelled.delete(request.id)) continue;
        scope.postMessage({id:request.id, ...model, revision});
      } catch (error) {
        scope.postMessage({id:request.id, error:error instanceof Error ? error.message : 'Could not compute this diff. Open the file to inspect its contents.'});
      } finally { active = undefined; cancelled.clear(); }
    }
  } finally { draining = false; }
}

scope.onmessage = event => {
  const request = event.data as DiffWorkerRequest;
  if ('cancel' in request) {
    const index = queue.findIndex(item => item.id === request.id);
    if (index >= 0) queue.splice(index, 1); else if (request.id === active) cancelled.add(request.id);
    return;
  }
  queue.push(request);
  void drain();
};
