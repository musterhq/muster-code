import type {DiffModel} from './diffModel';

/**
 * A small shared pool of diff workers (PER-15), used by every DiffView. Workers are created lazily, one
 * more only while every existing worker is busy and the pool is under its cap, so a single diff never
 * pays for a second thread. Requests carry an id; a superseded request is cancelled in its worker. Each
 * worker is terminated after DIFF_WORKER_IDLE_MS without work (the next request recreates one). A
 * worker that cannot load or crashes rejects its pending requests with DiffWorkerError so callers fall
 * back to the main thread.
 */
export const DIFF_WORKER_IDLE_MS = 60_000;
export const DIFF_WORKER_NAME = 'muster-diff';
/** Hard ceiling: diffs are bursty (opening a review), never worth more than two background threads. */
export const DIFF_WORKER_POOL_MAX = 2;

export class DiffWorkerError extends Error {
  constructor(message = 'Diff worker unavailable') { super(message); this.name = 'DiffWorkerError'; }
}

export interface DiffRequest { before: string; after: string; ignoreWhitespace?: boolean }
export interface DiffHandle { promise: Promise<DiffModel>; cancel: () => void }
type Pending = {resolve: (model: DiffModel) => void; reject: (error: Error) => void; slot: Slot};
type Slot = {worker: Worker; load: number; idleTimer?: ReturnType<typeof setTimeout>};

const slots: Slot[] = [];
let nextId = 0;
let poolLimit = defaultPoolLimit();
const pending = new Map<number, Pending>();

function defaultPoolLimit(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(DIFF_WORKER_POOL_MAX, cores - 1));
}

/** Cap the pool (tests, low-memory hosts). Existing extra workers drain and idle out normally. */
export function setDiffWorkerPoolLimit(limit: number): void {
  poolLimit = Math.max(1, Math.min(DIFF_WORKER_POOL_MAX, Math.floor(limit) || 1));
}

function releaseSlot(slot: Slot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = undefined;
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
  slot.worker.terminate();
}

function failSlot(slot: Slot, error: Error): void {
  for (const [id, task] of pending) if (task.slot === slot) { pending.delete(id); task.reject(error); }
  releaseSlot(slot);
}

function scheduleIdleRelease(slot: Slot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = undefined;
  if (slot.load > 0 || !slots.includes(slot)) return;
  slot.idleTimer = setTimeout(() => { slot.idleTimer = undefined; if (slot.load === 0) releaseSlot(slot); }, DIFF_WORKER_IDLE_MS);
}

function createSlot(): Slot {
  // Bundled beside renderer/main.js; esbuild flattens the source directory.
  const worker = new Worker(new URL('./diff-worker.js', document.baseURI), {type: 'module', name: DIFF_WORKER_NAME});
  const slot: Slot = {worker, load: 0};
  worker.onmessage = (event: MessageEvent<{id: number; error?: string} & Partial<DiffModel>>) => {
    const task = pending.get(event.data.id);
    if (!task) return;
    pending.delete(event.data.id);
    task.slot.load = Math.max(0, task.slot.load - 1);
    if (event.data.error !== undefined) task.reject(new Error(event.data.error));
    else { const {id: _id, error: _error, ...model} = event.data; task.resolve(model as DiffModel); }
    scheduleIdleRelease(task.slot);
  };
  worker.onerror = event => { event.preventDefault?.(); failSlot(slot, new DiffWorkerError('Diff worker could not load')); };
  slots.push(slot);
  return slot;
}

/** The least-loaded worker; a new one only when all are busy and the pool has room. */
function pickSlot(): Slot {
  const idle = slots.find(slot => slot.load === 0);
  if (idle) return idle;
  if (slots.length < poolLimit) return createSlot();
  return slots.reduce((best, slot) => slot.load < best.load ? slot : best, slots[0]!);
}

/** Terminate every pooled worker now (worker failure, tests). */
export function releaseDiffWorker(): void {
  for (const slot of [...slots]) releaseSlot(slot);
}

export function diffWorkerActive(): boolean { return slots.length > 0; }
export function diffWorkerCount(): number { return slots.length; }
export function pendingDiffRequests(): number { return pending.size; }

export function requestDiff(input: DiffRequest): DiffHandle {
  const id = ++nextId;
  let settled = false;
  let slot: Slot | undefined;
  const promise = new Promise<DiffModel>((resolve, reject) => {
    try {
      slot = pickSlot();
      if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = undefined; }
      pending.set(id, {slot, resolve: model => {settled = true; resolve(model);}, reject: error => {settled = true; reject(error);}});
      slot.load++;
      slot.worker.postMessage({id, before: input.before, after: input.after, ignoreWhitespace: input.ignoreWhitespace});
    } catch (error) {
      pending.delete(id);
      settled = true;
      if (slot) { slot.load = Math.max(0, slot.load - 1); scheduleIdleRelease(slot); }
      reject(new DiffWorkerError(error instanceof Error ? error.message : 'Diff worker could not start'));
    }
  });
  const cancel = () => {
    const task = pending.get(id);
    if (settled || !task) return;
    pending.delete(id);
    settled = true;
    task.slot.load = Math.max(0, task.slot.load - 1);
    try { task.slot.worker.postMessage({id, cancel: true}); } catch { /* worker already gone */ }
    scheduleIdleRelease(task.slot);
  };
  return {promise, cancel};
}
