/** Device stream reliability (#811): a stream that goes silent while its connection stays open is caught within a
 *  bounded time and recovers on its own. Fakes stand in for the helper; a manual clock drives every timer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DeviceLink, STALL_TIMEOUT_MS, type LinkDeps, type LinkEvents, type LinkFrame} from '../src/main/devices/link.ts';
import {SEMU_MAGIC} from '../src/main/devices/frames.ts';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
/** A manual clock for the link's timers: nothing fires until `advance` passes its time. */
function clock() {
  let now = 0, seq = 0;
  const timers = new Map<number, {at: number; fn: () => void}>();
  const set = ((fn: () => void, ms = 0) => { const id = ++seq; timers.set(id, {at: now + ms, fn}); return id; }) as unknown as typeof setTimeout;
  const clear = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  };
  return {set, clear, advance, get now() { return now; }};
}
class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = ''; readyState = 0; sent: unknown[] = [];
  onopen: ((e: unknown) => void) | null = null; onmessage: ((e: {data: unknown}) => void) | null = null; onclose: ((e: {code: number; reason: string}) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) { FakeSocket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(data: unknown) { this.sent.push(data); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({code: 1000, reason: ''}); }
}
const hub = async () => ({origin: 'http://127.0.0.1:5555', token: 'tok', pid: 1});
const envelope = (tag: number, payload: number[]) => { const b = Buffer.alloc(5 + payload.length); b.writeUInt32BE(1 + payload.length, 0); b[4] = tag; Buffer.from(payload).copy(b, 5); return b; };
const SEED = envelope(4, [0xff, 0xd8, 9, 0xff, 0xd9]), DESCRIPTION = envelope(1, [1, 0x64, 0x00, 0x33, 0xff]);
const KEY = envelope(2, [0, 0, 0, 1, 0x65]), DELTA = envelope(3, [0, 0, 0, 1, 0x41]);
const jpegPart = (n: number) => { const data = Buffer.from([0xff, 0xd8, n, n, n, 0xff, 0xd9]); return Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`), data, Buffer.from('\r\n')]); };

/** A helper whose streams stay open and send only what the test pushes (so they can go silent mid-body). */
function fakeHelper() {
  const requests: string[] = [];
  const streams: {url: string; push(chunk: Uint8Array): void; aborted: boolean}[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    requests.push(url);
    if (url.endsWith('/grid/api/start')) return new Response('{"ok":true}');
    const entry = {url, push: (_: Uint8Array) => {}, aborted: false};
    const body = new ReadableStream<Uint8Array>({start(controller) {
      entry.push = chunk => { try { controller.enqueue(chunk); } catch {} };
      init.signal?.addEventListener('abort', () => { entry.aborted = true; try { controller.error(new Error('aborted')); } catch {} });
    }});
    streams.push(entry);
    return new Response(body);
  }) as typeof fetch;
  return {requests, streams, fetchFn, opened: (suffix: string) => requests.filter(url => url.endsWith(suffix)).length};
}
function recorder() {
  const frames: LinkFrame[] = [], states: {state: string; detail?: string}[] = [];
  const events: LinkEvents = {frame: f => frames.push(f), state: (state, detail) => states.push({state, ...(detail ? {detail} : {})}), screen: () => {}, input: () => {}};
  return {frames, states, events, last: () => states.at(-1)!};
}

// Spec: MUS-SPEC-21-811C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-811c)
test('watchdog, iOS: an AVCC or MJPEG body that goes silent mid-stream is reopened within the bound and goes live again', async () => {
  const time = clock(), helper = fakeHelper(), rec = recorder();
  FakeSocket.all = [];
  const deps: LinkDeps = {hub, fetch: helper.fetchFn, socket: (url, headers) => new FakeSocket(url, headers) as never, setTimeout: time.set, clearTimeout: time.clear};
  const link = new DeviceLink('ios', 'BBBBBBBB-2222', deps, rec.events);
  await link.start();
  link.setViewing(true); await flush();
  assert.equal(helper.opened('stream.avcc'), 1);
  // The seed picture alone is not the H.264 stream working: the link stays "starting" until an access unit arrives.
  helper.streams.at(-1)!.push(SEED); await flush();
  assert.equal(rec.last().state, 'starting', 'the seed JPEG is not counted as the first H.264 frame');
  helper.streams.at(-1)!.push(Buffer.concat([DESCRIPTION, KEY, DELTA])); await flush();
  assert.equal(rec.last().state, 'live');
  // Frames keep the stream alive; then the body stays open but sends nothing.
  await time.advance(STALL_TIMEOUT_MS - 1000);
  helper.streams.at(-1)!.push(DELTA); await flush();
  await time.advance(STALL_TIMEOUT_MS - 1000);
  assert.equal(rec.last().state, 'live', 'each frame restarts the bound');
  assert.equal(helper.opened('stream.avcc'), 1);
  await time.advance(1000);
  assert.equal(rec.last().state, 'reconnecting', 'silence for the bound is caught');
  assert.match(rec.last().detail ?? '', /stopped sending video/);
  assert.equal(helper.streams[0]!.aborted, true, 'the silent body is closed');
  await time.advance(1000);
  assert.equal(helper.opened('stream.avcc'), 2, 'and reopened after the first retry step');
  helper.streams.at(-1)!.push(Buffer.concat([SEED, DESCRIPTION, KEY])); await flush();
  assert.equal(rec.last().state, 'live', 'the fresh subscription is live again, with no user action');
  assert.equal(rec.frames.filter(f => f.config).length, 2, 'the new subscription brought a new description');

  // MJPEG (a window that cannot decode H.264) has the same bound.
  link.preferMjpeg(); await flush();
  assert.equal(helper.opened('stream.mjpeg'), 1);
  helper.streams.at(-1)!.push(jpegPart(1)); await flush();
  assert.equal(rec.last().state, 'live');
  await time.advance(STALL_TIMEOUT_MS);
  assert.equal(rec.last().state, 'reconnecting');
  await time.advance(1000);
  assert.equal(helper.opened('stream.mjpeg'), 2, 'a silent MJPEG body is reopened too');
  link.close();
});

// Spec: MUS-SPEC-21-811D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-811d)
test('watchdog, Android: a silent video socket first gets a keyframe request, then is reopened if it stays silent', async () => {
  const time = clock(), rec = recorder();
  FakeSocket.all = [];
  const deps: LinkDeps = {hub, fetch: (async () => new Response('{}')) as typeof fetch, socket: (url, headers) => new FakeSocket(url, headers) as never, setTimeout: time.set, clearTimeout: time.clear};
  const link = new DeviceLink('android', 'emulator-5554', deps, rec.events);
  await link.start();
  link.setViewing(true); await flush();
  const video = FakeSocket.all.find(s => /frame-meta=1/.test(s.url))!;
  video.open();
  const unit = (key: boolean) => { const h = Buffer.alloc(17); h.writeUInt32BE(SEMU_MAGIC, 0); h[4] = 1; h[5] = key ? 1 : 0; return new Uint8Array(h).buffer; };
  video.onmessage!({data: unit(true)});
  assert.equal(rec.last().state, 'live');
  await time.advance(STALL_TIMEOUT_MS - 1);
  video.onmessage!({data: unit(false)});
  await time.advance(STALL_TIMEOUT_MS - 1);
  assert.equal(video.sent.length, 0, 'a socket that keeps sending is left alone');
  await time.advance(1);
  assert.deepEqual(JSON.parse(video.sent.at(-1) as string), {type: 'reset-video', ack: false}, 'silence for the bound asks for a keyframe');
  assert.equal(video.readyState, 1, 'without dropping the connection');
  // The keyframe comes: the stream carries on.
  video.onmessage!({data: unit(true)});
  await time.advance(STALL_TIMEOUT_MS - 1);
  assert.equal(video.readyState, 1);
  // Silent again, and the keyframe request goes unanswered: the socket is replaced.
  await time.advance(1);
  assert.equal(video.sent.length, 2, 'a second keyframe request');
  await time.advance(STALL_TIMEOUT_MS);
  assert.equal(video.readyState, 3, 'still silent after the request: the socket is closed');
  assert.match(rec.states.map(s => s.detail ?? '').join(' '), /stopped sending video/);
  await time.advance(1000);
  const next = FakeSocket.all.filter(s => /frame-meta=1/.test(s.url));
  assert.equal(next.length, 2, 'and a new video socket is opened');
  next[1]!.open(); next[1]!.onmessage!({data: unit(true)});
  assert.equal(rec.last().state, 'live');
  link.close();
});
