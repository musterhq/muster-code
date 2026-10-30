/**
 * One live device link (#363): main's own client of the loopback helper. The renderer never talks to the helper; it
 * gets frames over IPC and sends input through main, which forwards only the typed messages below.
 *
 * - Video runs only while a viewer is active (a visible tab or PiP card in a window that is in front); with none, the
 *   stream is closed, so an unwatched device costs nothing.
 * - Input stays connected while the session is open, so an agent's tap works with no viewer.
 * - iOS: H.264 over HTTP (the helper's AVCC body, demuxed here and forwarded in order; a renderer that falls behind
 *   reopens it for a fresh keyframe), or MJPEG with latest-frame-wins flow control when the window cannot decode H.264;
 *   input on the helper's binary socket. The H.264 flow adapts T3 Code's device stream client (MIT, Copyright (c) 2026
 *   T3 Tools Inc.; see THIRD-PARTY-NOTICES.md).
 *   Android: an H.264 socket (forwarded in order; on backlog, dropped up to the next keyframe) + an input-only socket.
 * - Every failure reconnects with backoff; after the first frame never arrives, the state says so in plain English.
 * - A stream that goes silent while its connection stays open is caught within STALL_TIMEOUT_MS and recovers (#811).
 */
import type {DeviceInput, DeviceOrientation, DevicePlatform, DeviceScreen, DeviceSessionState} from '../../shared/device-protocol.ts';
import {AvccDemuxer, FrameGate, IOS_TAG, iosPacket, MjpegParser, semuInfo} from './frames.ts';
import {androidKeycode, hidForChar, hidUsageForCode} from './keys.ts';
import type {HubEndpoint} from './helper.ts';

export const FIRST_FRAME_TIMEOUT_MS = 15_000, RETRY_MS = [1000, 2000, 4000, 8000];
/**
 * The watchdog (#811): a video body or socket can stay open after the helper stops producing frames. Silence this long
 * (no bytes on an iOS body, no message on the Android socket) is a stall: iOS reopens the stream (a fresh subscription
 * starts with a keyframe); Android first asks for a keyframe and reopens only if the next bound is silent too.
 */
export const STALL_TIMEOUT_MS = FIRST_FRAME_TIMEOUT_MS;
const STALLED = Symbol('stalled');
/**
 * The WebRTC backup (#811, iOS). When the main stream fails FAILOVER_FAILURES times within FAILOVER_WINDOW_MS (stalls
 * included), or the helper says it is locked to WebRTC, the renderer is told to open a WebRTC connection instead. Main
 * signals it (the renderer's offer reaches the helper only through webrtcOffer, with the token); the media goes
 * straight to the renderer. Main checks the main stream again after MAIN_RECHECK_MS (backing off) and switches back on
 * its first keyframe. Three backup failures in a row give the backup up until the user reconnects.
 * Android does not switch: serve-emu's WebRTC needs a native module that Muster's script-free helper install omits.
 */
export const FAILOVER_FAILURES = 3, FAILOVER_WINDOW_MS = 120_000, MAIN_RECHECK_MS = [30_000, 60_000, 120_000, 300_000], WEBRTC_ATTEMPTS = 3;
/** serve-sim's own limit on an offer's SDP. */
export const MAX_SDP = 245_760;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Which path carries a session's video: the main stream (frames over IPC) or the WebRTC backup (media in the renderer). */
export interface LinkStream {path: 'main' | 'webrtc'; attempt: number; active: boolean}
export type WebRtcReport = 'frame' | 'stalled' | 'failed' | 'unsupported';
/** Unacknowledged H.264 units before the link drops to the next keyframe (about one second at 30 fps). */
export const H264_BACKLOG = 30;
export interface LinkFrame {codec: 'jpeg' | 'h264'; key: boolean; data: Buffer; pts?: number; reset?: boolean; format?: 'annexb' | 'avcc'; config?: boolean}
/** What a link is streaming and how much (diagnostics, the CI smoke's measurements). */
export interface LinkStats {transport: 'avcc' | 'mjpeg' | 'semu' | 'webrtc' | 'none'; frames: number; keyframes: number; bytes: number; restarts: number; since: number}
export interface LinkEvents {
  frame(frame: LinkFrame): void;
  state(state: DeviceSessionState, detail?: string): void;
  screen(screen: DeviceScreen): void;
  input(ready: boolean): void;
  /** The video path changed (#811); without this listener the link never switches to the backup. */
  stream?(stream: LinkStream): void;
}
type Socket = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {binaryType: string; onopen: ((e: unknown) => void) | null; onmessage: ((e: {data: unknown}) => void) | null; onclose: ((e: {code: number; reason: string}) => void) | null; onerror: ((e: unknown) => void) | null};
export interface LinkDeps {
  hub(): Promise<HubEndpoint>;
  fetch: typeof fetch;
  socket(url: string, headers: Record<string, string>): Socket;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  now?: () => number;
}
const ORIENTATIONS: DeviceOrientation[] = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right'];
const OPEN = 1;

export class DeviceLink {
  private viewing = false;
  private closed = false;
  private video?: {abort(): void};
  private videoSocket?: Socket;
  private inputSocket?: Socket;
  private admitted = false;
  private firstFrameTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private inputRetry?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private gotFrame = false;
  private gate = new FrameGate(2);
  private h264Backlog = 0;
  private dropping = false;
  private stallTimer?: ReturnType<typeof setTimeout>;
  // The WebRTC backup (#811).
  private path: LinkStream['path'] = 'main';
  private attempt = 0;
  private webrtcActive = false;
  private webrtcSession?: string;
  /** This window cannot play WebRTC, or the backup failed WEBRTC_ATTEMPTS times: stay on the main stream until Reconnect. */
  private webrtcOff = false;
  private webrtcFailures = 0;
  private failures: number[] = [];
  private checkTimer?: ReturnType<typeof setTimeout>;
  private checkStep = 0;
  private check?: AbortController;
  /** iOS: H.264 (AVCC) unless this window cannot decode it or the helper does not offer it, then MJPEG. */
  private mjpegOnly = false;
  stats: LinkStats = {transport: 'none', frames: 0, keyframes: 0, bytes: 0, restarts: 0, since: Date.now()};
  screen?: DeviceScreen;
  constructor(readonly platform: DevicePlatform, readonly deviceId: string, private readonly deps: LinkDeps, private readonly events: LinkEvents) {}

  private auth(hub: HubEndpoint) { return {authorization: `Bearer ${hub.token}`}; }
  private vendor() { return this.platform === 'ios' ? '/vendor/serve-sim' : '/vendor/serve-emu'; }

  /** Opens the input channel (and, on iOS, attaches the simulator's capture helper). */
  async start(): Promise<void> {
    this.closed = false;
    const hub = await this.deps.hub();
    if (this.platform === 'ios') {
      // Attaching the helper is idempotent for a booted simulator.
      const response = await this.deps.fetch(`${hub.origin}/vendor/serve-sim/grid/api/start`, {method: 'POST', headers: {...this.auth(hub), 'content-type': 'application/json'}, body: JSON.stringify({udid: this.deviceId}), signal: AbortSignal.timeout(240_000)});
      if (!response.ok) throw new Error(`The device helper could not attach to the simulator (${response.status}).`);
      const result = await response.json().catch(() => ({})) as {ok?: boolean; error?: string};
      if (result.ok === false) throw new Error(result.error || 'The device helper could not attach to the simulator.');
    }
    this.connectInput(hub);
  }

  /** A viewer appeared or went away. Video flows only while one is active. */
  setViewing(viewing: boolean): void {
    if (this.closed || viewing === this.viewing) return;
    this.viewing = viewing;
    if (viewing) { this.retries = 0; void this.startVideo(); }
    else this.stopVideo();
  }
  ack(): void {
    if (this.platform === 'android' || this.stats.transport === 'avcc') { this.h264Backlog = Math.max(0, this.h264Backlog - 1); return; }
    const next = this.gate.ack();
    if (next) this.forward({codec: 'jpeg', key: true, data: next}, 'mjpeg');
  }

  private async startVideo(): Promise<void> {
    this.stopVideo(false);
    if (this.closed || !this.viewing) return;
    this.gotFrame = false; this.gate.reset(); this.h264Backlog = 0; this.dropping = false;
    this.events.state(this.retries ? 'reconnecting' : 'starting');
    this.firstFrameTimer = this.deps.setTimeout(() => this.videoFailed('No video arrived from the device.'), FIRST_FRAME_TIMEOUT_MS);
    if (this.path === 'webrtc') { this.attempt++; this.webrtcActive = true; this.emitStream(); if (!this.checkTimer && !this.check) this.scheduleCheck(); return; }
    let hub: HubEndpoint;
    try { hub = await this.deps.hub(); } catch (error) { this.videoFailed(message(error)); return; }
    if (this.closed || !this.viewing) return;
    if (this.platform === 'ios') void (this.mjpegOnly ? this.readMjpeg(hub) : this.readAvcc(hub));
    else this.openAndroidVideo(hub);
  }
  /** Android's video socket is also its input socket (serve-emu keeps one connection per device); closing it reopens
   *  an input-only one unless the video is about to restart. */
  private stopVideo(reopenInput = true): void {
    if (this.firstFrameTimer) this.deps.clearTimeout(this.firstFrameTimer);
    if (this.retryTimer) this.deps.clearTimeout(this.retryTimer);
    if (this.stallTimer) this.deps.clearTimeout(this.stallTimer);
    this.firstFrameTimer = this.retryTimer = this.stallTimer = undefined;
    this.video?.abort(); this.video = undefined;
    if (this.webrtcActive) { this.webrtcActive = false; void this.closeWebRtc(); this.emitStream(); }
    if (!this.viewing || this.closed) this.stopCheck();
    const socket = this.videoSocket; this.videoSocket = undefined;
    if (socket && this.inputSocket === socket) { this.inputSocket = undefined; this.admitted = false; this.events.input(false); }
    try { socket?.close(); } catch {}
    if (reopenInput && this.platform === 'android' && !this.closed && !this.inputSocket) void this.deps.hub().then(hub => this.connectInput(hub), () => {});
  }
  private frameArrived(): void {
    if (this.gotFrame) return;
    this.gotFrame = true; this.retries = 0;
    if (this.firstFrameTimer) this.deps.clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = undefined;
    this.events.state('live');
  }
  private videoFailed(detail: string): void {
    if (this.closed || !this.viewing) return;
    if (this.path === 'webrtc') { this.webrtcFailed(detail); return; }
    if (this.canFailover()) {
      const now = this.now();
      this.failures = [...this.failures.filter(at => now - at < FAILOVER_WINDOW_MS), now];
      if (this.failures.length >= FAILOVER_FAILURES) { this.failover(); return; }
    }
    this.stopVideo(this.retries >= RETRY_MS.length);
    if (this.retries >= RETRY_MS.length) { this.events.state('error', `${detail} Reconnect to try again.`); return; }
    const wait = RETRY_MS[this.retries++]!;
    this.events.state('reconnecting', detail);
    this.retryTimer = this.deps.setTimeout(() => void this.startVideo(), wait);
  }
  /** The renderer cannot decode H.264: stream MJPEG from now on. */
  preferMjpeg(): void { if (this.platform !== 'ios' || this.mjpegOnly) return; this.mjpegOnly = true; if (this.viewing) { this.retries = 0; void this.startVideo(); } }
  private count(frame: LinkFrame, transport: LinkStats['transport']): void {
    if (this.stats.transport !== transport) this.stats = {transport, frames: 0, keyframes: 0, bytes: 0, restarts: this.stats.restarts, since: Date.now()};
    if (frame.config) return;
    this.stats.frames++; this.stats.bytes += frame.data.length; if (frame.key) this.stats.keyframes++;
  }
  /** Restarts video after an error (the Reconnect button); the backup may be tried again. */
  reconnect(): void { this.retries = 0; this.webrtcOff = false; this.failures = []; if (this.viewing) void this.startVideo(); if (!this.inputSocket) void this.deps.hub().then(hub => this.connectInput(hub), () => {}); }

  /**
   * iOS H.264: serve-sim's AVCC body, demuxed here and forwarded in order (a seed JPEG first, then the decoder
   * description, then access units). If the renderer falls behind, the subscription is reopened: a fresh one starts
   * with a new description and keyframe, where waiting could take minutes on an idle simulator.
   */
  private async readAvcc(hub: HubEndpoint, checking = false): Promise<void> {
    const controller = new AbortController();
    // A check of the main stream while the backup runs (#811): nothing is forwarded until its first keyframe.
    let probing = checking;
    let description: Buffer | undefined;
    if (probing) this.check = controller; else { this.video = controller; this.h264Backlog = 0; }
    const demuxer = new AvccDemuxer();
    const failed = (detail: string) => { if (probing) this.checkFailed(controller); else if (this.video === controller && !controller.signal.aborted) this.videoFailed(detail); };
    try {
      const response = await this.deps.fetch(`${hub.origin}/vendor/serve-sim/helper/${encodeURIComponent(this.deviceId)}/stream.avcc`, {headers: this.auth(hub), signal: controller.signal});
      if (probing && !response.ok) { await response.body?.cancel().catch(() => {}); failed(''); return; }
      // Locked to WebRTC: MJPEG is locked too, so this is the backup's job.
      if (response.status === 409 && this.canFailover()) {
        const body = await response.json().catch(() => null) as {error?: string; transport?: string} | null;
        if (controller.signal.aborted) return;
        if (body?.error === 'stream_transport_locked' && body.transport === 'webrtc') { this.failover(); return; }
        this.mjpegOnly = true; void this.startVideo();
        return;
      }
      // A helper without the H.264 route (or locked to another transport) still streams MJPEG.
      if (response.status === 404 || response.status === 405 || response.status === 409) { await response.body?.cancel().catch(() => {}); this.mjpegOnly = true; if (!controller.signal.aborted) void this.startVideo(); return; }
      if (!response.ok || !response.body) throw new Error(response.status === 401 ? 'The device helper refused the connection.' : `The simulator stream answered ${response.status}.`);
      const reader = response.body.getReader();
      for (;;) {
        const result = await this.boundedRead(reader, controller);
        if (result === STALLED) { if (probing) failed(''); else this.stalled(controller, 'The device stopped sending video.'); return; }
        const {done, value} = result;
        if (done || controller.signal.aborted) break;
        for (const chunk of demuxer.push(value)) {
          if (controller.signal.aborted) break;
          if (probing) {
            if (chunk.kind === 'description') description = chunk.payload;
            if (chunk.kind !== 'keyframe') continue;
            // Healthy again: this subscription becomes the stream, starting from its description and this keyframe.
            probing = false;
            this.switchToMain(controller);
            if (description) this.forward({codec: 'h264', format: 'avcc', config: true, key: false, data: description}, 'avcc');
          }
          // The seed picture is shown, but only an access unit proves the H.264 stream works (#811).
          if (chunk.kind === 'seed') { this.forward({codec: 'jpeg', key: true, data: chunk.payload}, 'avcc'); continue; }
          if (chunk.kind === 'description') { this.forward({codec: 'h264', format: 'avcc', config: true, key: false, data: chunk.payload}, 'avcc'); continue; }
          if (this.h264Backlog >= H264_BACKLOG) {
            // Behind by about a second: start over from a fresh keyframe rather than queue more.
            this.stats.restarts++;
            controller.abort();
            this.retries = 0;
            void this.startVideo();
            return;
          }
          this.frameArrived();
          this.h264Backlog++;
          this.forward({codec: 'h264', format: 'avcc', key: chunk.kind === 'keyframe', data: chunk.payload}, 'avcc');
        }
      }
      if (!controller.signal.aborted) failed('The simulator stream ended.');
    } catch (error) {
      if (!controller.signal.aborted || probing) failed(message(error));
    }
  }

  // --- The WebRTC backup (#811) ---------------------------------------------------------------------------------
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private canFailover(): boolean { return this.platform === 'ios' && !this.webrtcOff && !!this.events.stream; }
  private emitStream(): void { this.events.stream?.({path: this.path, attempt: this.attempt, active: this.path === 'webrtc' && this.webrtcActive}); }
  /** The main stream keeps failing (or is locked to WebRTC): the renderer opens the backup. */
  private failover(): void {
    this.stopVideo(false);
    this.path = 'webrtc'; this.failures = []; this.webrtcFailures = 0; this.retries = 0; this.checkStep = 0;
    this.events.state('reconnecting', 'The video stream keeps failing. Switching to the backup connection.');
    this.scheduleCheck();
    void this.startVideo();
  }
  private webrtcFailed(detail: string): void {
    this.stopVideo(false);
    if (++this.webrtcFailures >= WEBRTC_ATTEMPTS) {
      // The backup does not work here either: back to the main stream, whose own retries end in the error state.
      this.webrtcOff = true; this.path = 'main'; this.emitStream(); this.stopCheck();
      this.retries = 0; this.failures = [];
      this.events.state('reconnecting', detail);
      this.retryTimer = this.deps.setTimeout(() => void this.startVideo(), RETRY_MS[0]!);
      return;
    }
    this.events.state('reconnecting', detail);
    this.retryTimer = this.deps.setTimeout(() => void this.startVideo(), RETRY_MS[this.webrtcFailures - 1]!);
  }
  /** What the renderer saw on the backup, for the current attempt only. */
  webrtcReport(attempt: number, event: WebRtcReport): void {
    if (this.closed || this.path !== 'webrtc' || !this.webrtcActive || attempt !== this.attempt) return;
    if (event === 'frame') {
      if (this.stats.transport !== 'webrtc') this.stats = {transport: 'webrtc', frames: 0, keyframes: 0, bytes: 0, restarts: this.stats.restarts, since: this.now()};
      this.stats.frames++; this.webrtcFailures = 0;
      this.frameArrived();
      return;
    }
    if (event === 'unsupported') {
      this.stopVideo(false);
      this.webrtcOff = true; this.path = 'main'; this.emitStream(); this.stopCheck(); this.retries = 0;
      void this.startVideo();
      return;
    }
    this.webrtcFailed(event === 'stalled' ? 'The backup connection stopped sending video.' : 'The backup connection failed.');
  }
  /** The renderer's WebRTC offer, sent to the helper with the token; only the answer's SDP goes back. */
  async webrtcOffer(attempt: number, sessionId: string, sdp: string): Promise<string> {
    if (this.closed || this.path !== 'webrtc' || !this.webrtcActive || attempt !== this.attempt) throw new Error('The backup connection is not in use.');
    if (typeof sessionId !== 'string' || !UUID_V4.test(sessionId)) throw new Error('Invalid backup connection session.');
    if (typeof sdp !== 'string' || !sdp || sdp.length > MAX_SDP) throw new Error('Invalid backup connection offer.');
    if (this.webrtcSession && this.webrtcSession !== sessionId) await this.closeWebRtc();
    this.webrtcSession = sessionId;
    const hub = await this.deps.hub();
    const response = await this.deps.fetch(this.webrtcUrl(hub, 'offer'), {method: 'POST', headers: {...this.auth(hub), 'content-type': 'application/json'}, body: JSON.stringify({type: 'offer', sdp, sessionId, codec: 'h264'}), signal: AbortSignal.timeout(15_000)});
    if (!response.ok) throw new Error(response.status === 409 ? 'Another viewer is connecting to this device. Retrying.' : `The backup connection was refused (${response.status}).`);
    const answer = await response.json().catch(() => null) as {type?: string; sdp?: unknown} | null;
    if (answer?.type !== 'answer' || typeof answer.sdp !== 'string' || !answer.sdp || answer.sdp.length > MAX_SDP) throw new Error('The device answered the backup connection with something unreadable.');
    if (this.path !== 'webrtc' || attempt !== this.attempt || !this.webrtcActive) { void this.closeWebRtc(); throw new Error('The backup connection is not in use.'); }
    return answer.sdp;
  }
  private webrtcUrl(hub: HubEndpoint, action: 'offer' | 'close'): string { return `${hub.origin}/vendor/serve-sim/helper/${encodeURIComponent(this.deviceId)}/webrtc/${action}`; }
  /** Releases the helper's WebRTC session (best effort). */
  private async closeWebRtc(): Promise<void> {
    const sessionId = this.webrtcSession; this.webrtcSession = undefined;
    if (!sessionId) return;
    try {
      const hub = await this.deps.hub();
      await this.deps.fetch(this.webrtcUrl(hub, 'close'), {method: 'POST', headers: {...this.auth(hub), 'content-type': 'application/json'}, body: JSON.stringify({sessionId}), signal: AbortSignal.timeout(5000)});
    } catch {}
  }
  private scheduleCheck(): void {
    if (this.checkTimer) this.deps.clearTimeout(this.checkTimer);
    const wait = MAIN_RECHECK_MS[Math.min(this.checkStep, MAIN_RECHECK_MS.length - 1)]!;
    this.checkTimer = this.deps.setTimeout(() => { this.checkTimer = undefined; void this.checkMain(); }, wait);
  }
  private stopCheck(): void {
    if (this.checkTimer) this.deps.clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    const check = this.check; this.check = undefined; check?.abort();
  }
  private async checkMain(): Promise<void> {
    if (this.closed || this.path !== 'webrtc' || this.check) return;
    if (!this.viewing) { this.scheduleCheck(); return; }
    try { await this.readAvcc(await this.deps.hub(), true); } catch { this.checkStep++; this.scheduleCheck(); }
  }
  private checkFailed(controller: AbortController): void {
    if (this.check !== controller) return;
    this.check = undefined; controller.abort();
    this.checkStep++;
    if (this.path === 'webrtc' && !this.closed) this.scheduleCheck();
  }
  private switchToMain(controller: AbortController): void {
    this.check = undefined;
    if (this.checkTimer) this.deps.clearTimeout(this.checkTimer);
    this.checkTimer = undefined; this.checkStep = 0;
    this.stopVideo(false);
    this.path = 'main'; this.failures = []; this.retries = 0; this.webrtcFailures = 0;
    this.emitStream();
    this.video = controller; this.gotFrame = false; this.h264Backlog = 0;
  }
  /** One read of a video body, bounded: STALLED when nothing arrives within STALL_TIMEOUT_MS (the body is then closed). */
  private boundedRead(reader: ReadableStreamDefaultReader<Uint8Array>, controller: AbortController): Promise<ReadableStreamReadResult<Uint8Array> | typeof STALLED> {
    return new Promise((resolve, reject) => {
      const timer = this.deps.setTimeout(() => { resolve(STALLED); controller.abort(); void reader.cancel().catch(() => {}); }, STALL_TIMEOUT_MS);
      reader.read().then(result => { this.deps.clearTimeout(timer); resolve(result); }, error => { this.deps.clearTimeout(timer); reject(error); });
    });
  }
  /** The current stream went silent: recover as from any failure (the stream had been working, so from the first step). */
  private stalled(controller: AbortController, detail: string): void {
    if (this.video !== controller || this.closed || !this.viewing) return;
    this.videoFailed(detail);
  }
  private forward(frame: LinkFrame, transport: LinkStats['transport']): void { this.count(frame, transport); this.events.frame(frame); }
  private async readMjpeg(hub: HubEndpoint): Promise<void> {
    const controller = new AbortController();
    this.video = controller;
    const parser = new MjpegParser();
    try {
      const response = await this.deps.fetch(`${hub.origin}/vendor/serve-sim/helper/${encodeURIComponent(this.deviceId)}/stream.mjpeg`, {headers: this.auth(hub), signal: controller.signal});
      if (!response.ok || !response.body) throw new Error(response.status === 401 ? 'The device helper refused the connection.' : `The simulator stream answered ${response.status}.`);
      const reader = response.body.getReader();
      for (;;) {
        const result = await this.boundedRead(reader, controller);
        if (result === STALLED) { this.stalled(controller, 'The device stopped sending video.'); return; }
        const {done, value} = result;
        if (done || controller.signal.aborted) break;
        for (const jpeg of parser.push(value)) {
          this.frameArrived();
          const out = this.gate.offer(jpeg, true);
          if (out) this.forward({codec: 'jpeg', key: true, data: out}, 'mjpeg');
        }
      }
      if (!controller.signal.aborted) this.videoFailed('The simulator stream ended.');
    } catch (error) {
      if (!controller.signal.aborted) this.videoFailed(message(error));
    }
  }
  private openAndroidVideo(hub: HubEndpoint): void {
    const wsOrigin = hub.origin.replace(/^http/, 'ws');
    // One connection per device: the input-only socket gives way to this one, which carries video and input.
    const input = this.inputSocket;
    if (input) { this.inputSocket = undefined; try { input.close(); } catch {} }
    const socket = this.deps.socket(`${wsOrigin}/vendor/serve-emu/ws?device=${encodeURIComponent(this.deviceId)}&frame-meta=1`, this.auth(hub));
    socket.binaryType = 'arraybuffer';
    this.videoSocket = socket; this.inputSocket = socket; this.admitted = true;
    // Watchdog: silence asks for a keyframe once; a second silent bound replaces the socket.
    let asked = false;
    const watch = () => {
      if (this.stallTimer) this.deps.clearTimeout(this.stallTimer);
      this.stallTimer = this.deps.setTimeout(() => {
        this.stallTimer = undefined;
        if (this.videoSocket !== socket) return;
        if (!asked) { asked = true; try { socket.send(JSON.stringify({type: 'reset-video', ack: false})); } catch {} watch(); return; }
        this.videoFailed('The device stopped sending video.');
      }, STALL_TIMEOUT_MS);
    };
    watch();
    socket.onopen = () => { if (this.inputSocket === socket) this.events.input(true); };
    socket.onmessage = event => {
      if (this.videoSocket !== socket) return;
      asked = false; watch();
      if (typeof event.data === 'string') {
        // The encoder restarted (rotation, resize): the renderer rebuilds its decoder from the next keyframe.
        if (/"video-session"/.test(event.data)) { this.dropping = false; this.h264Backlog = 0; this.events.frame({codec: 'h264', key: false, data: Buffer.alloc(0), reset: true}); }
        return;
      }
      const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data instanceof Uint8Array ? event.data : null;
      if (!bytes) return;
      const info = semuInfo(bytes);
      if (this.dropping) { if (!info.key) return; this.dropping = false; }
      if (this.h264Backlog >= H264_BACKLOG) {
        // The renderer fell behind: skip to the next keyframe rather than queueing seconds of video.
        this.dropping = true; this.h264Backlog = 0;
        try { socket.send(JSON.stringify({type: 'reset-video', ack: false})); } catch {}
        return;
      }
      this.frameArrived();
      this.h264Backlog++;
      this.forward({codec: 'h264', format: 'annexb', key: info.key, data: Buffer.from(bytes.subarray(info.payloadOffset)), ...(info.pts !== undefined ? {pts: info.pts} : {})}, 'semu');
    };
    socket.onclose = event => {
      if (this.videoSocket !== socket) return;
      this.videoSocket = undefined;
      if (this.inputSocket === socket) { this.inputSocket = undefined; this.admitted = false; this.events.input(false); }
      this.videoFailed(event.reason ? `The emulator stream closed: ${event.reason}.` : `The emulator stream closed (code ${event.code}).`);
    };
    socket.onerror = () => { try { socket.close(); } catch {} };
  }

  private connectInput(hub: HubEndpoint): void {
    if (this.closed || this.inputSocket || (this.platform === 'android' && this.videoSocket)) return;
    const wsOrigin = hub.origin.replace(/^http/, 'ws');
    const url = this.platform === 'ios'
      ? `${wsOrigin}/vendor/serve-sim/helper/ws?device=${encodeURIComponent(this.deviceId)}`
      : `${wsOrigin}/vendor/serve-emu/ws?device=${encodeURIComponent(this.deviceId)}&video=0`;
    const socket = this.deps.socket(url, this.auth(hub));
    socket.binaryType = 'arraybuffer';
    this.inputSocket = socket; this.admitted = this.platform === 'android';
    socket.onopen = () => { if (this.platform === 'android') this.events.input(true); else void this.primeCapture(hub); };
    socket.onmessage = event => {
      if (this.platform !== 'ios' || !(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes[0] === IOS_TAG.inputAdmitted) { this.admitted = true; this.events.input(true); return; }
      if (bytes[0] !== IOS_TAG.screenConfig) return;
      try {
        const config = JSON.parse(Buffer.from(bytes.subarray(1)).toString('utf8')) as {width?: number; height?: number; orientation?: string; inputUnavailable?: boolean};
        if (typeof config.width === 'number' && typeof config.height === 'number' && config.width > 0 && config.height > 0) {
          this.screen = {width: config.width, height: config.height, orientation: (ORIENTATIONS as string[]).includes(config.orientation ?? '') ? config.orientation as DeviceOrientation : 'portrait'};
          this.events.screen(this.screen);
        }
        if (config.inputUnavailable) this.events.input(false);
      } catch {}
    };
    socket.onclose = () => {
      if (this.inputSocket !== socket) return;
      this.inputSocket = undefined; this.admitted = false; this.events.input(false);
      if (!this.closed) this.inputRetry ??= this.deps.setTimeout(() => { this.inputRetry = undefined; void this.deps.hub().then(next => this.connectInput(next), () => {}); }, 2000);
    };
    socket.onerror = () => { try { socket.close(); } catch {} };
  }
  /** serve-sim admits input only while capture runs; one short MJPEG read starts it (the socket then stays admitted). */
  private async primeCapture(hub: HubEndpoint): Promise<void> {
    if (this.viewing) return;
    const controller = new AbortController();
    const timer = this.deps.setTimeout(() => controller.abort(), 3000);
    try {
      const response = await this.deps.fetch(`${hub.origin}/vendor/serve-sim/helper/${encodeURIComponent(this.deviceId)}/stream.mjpeg`, {headers: this.auth(hub), signal: controller.signal});
      await response.body?.getReader().read();
    } catch {} finally { this.deps.clearTimeout(timer); controller.abort(); }
  }

  get inputReady(): boolean { return !!this.inputSocket && this.inputSocket.readyState === OPEN && this.admitted; }
  /** Waits up to `ms` for input to be admitted (an agent's first tap right after device_open). */
  async waitForInput(ms = 8000): Promise<boolean> {
    for (let waited = 0; waited < ms && !this.closed; waited += 100) { if (this.inputReady) return true; await new Promise(r => this.deps.setTimeout(r, 100)); }
    return this.inputReady;
  }
  private send(payload: Buffer | string): boolean {
    if (!this.inputReady) return false;
    try { this.inputSocket!.send(typeof payload === "string" ? payload : new Uint8Array(payload)); return true; } catch { return false; }
  }
  input(input: DeviceInput): boolean {
    if (this.platform === 'ios') {
      if (input.kind === 'touch') return this.send(iosPacket(IOS_TAG.touch, {type: input.phase, ...rawPoint(this.screen, input.x, input.y)}));
      if (input.kind === 'key') { const usage = hidUsageForCode(input.code); return usage !== null && this.send(iosPacket(IOS_TAG.key, {type: input.phase, usage})); }
      return this.typeIos(input.text);
    }
    if (input.kind === 'touch') return this.send(JSON.stringify({type: 'touch', action: input.phase === 'begin' ? 'down' : input.phase === 'move' ? 'move' : 'up', x: input.x, y: input.y}));
    if (input.kind === 'key') {
      if (input.phase !== 'down') return true;
      if (input.key === 'Escape') return this.send(JSON.stringify({type: 'back'}));
      const keycode = androidKeycode(input.key);
      if (keycode !== null) return this.send(JSON.stringify({type: 'key', keycode}));
      return input.key.length === 1 ? this.send(JSON.stringify({type: 'text', text: input.key})) : false;
    }
    return this.send(JSON.stringify({type: 'text', text: input.text}));
  }
  /** iOS has no text message: each character is a HID key press (with Shift where needed). ASCII only. */
  private typeIos(text: string): boolean {
    const keys = [...text].map(hidForChar);
    if (keys.some(key => key === null)) return false;
    for (const key of keys) {
      if (key!.shift) this.send(iosPacket(IOS_TAG.key, {type: 'down', usage: 0xe1}));
      this.send(iosPacket(IOS_TAG.key, {type: 'down', usage: key!.usage}));
      this.send(iosPacket(IOS_TAG.key, {type: 'up', usage: key!.usage}));
      if (key!.shift) this.send(iosPacket(IOS_TAG.key, {type: 'up', usage: 0xe1}));
    }
    return true;
  }
  button(button: 'home' | 'power' | 'appSwitcher' | 'back'): boolean {
    if (this.platform === 'ios') {
      const name = button === 'home' ? 'home' : button === 'appSwitcher' ? 'app_switcher' : button === 'power' ? 'lock' : null;
      return !!name && this.send(iosPacket(IOS_TAG.button, {button: name}));
    }
    return this.send(JSON.stringify({type: button === 'appSwitcher' ? 'recents' : button}));
  }
  /** iOS: the next orientation clockwise. Android rotates through the emulator console instead (see the manager). */
  rotate(): boolean {
    if (this.platform !== 'ios') return false;
    const current = this.screen?.orientation ?? 'portrait';
    return this.send(iosPacket(IOS_TAG.orientation, {orientation: ORIENTATIONS[(ORIENTATIONS.indexOf(current) + 1) % ORIENTATIONS.length]}));
  }
  close(): void {
    this.closed = true; this.viewing = false;
    this.stopVideo();
    if (this.inputRetry) this.deps.clearTimeout(this.inputRetry);
    this.inputRetry = undefined;
    const socket = this.inputSocket; this.inputSocket = undefined;
    try { socket?.close(); } catch {}
  }
}
/** serve-sim takes touches in the raw (portrait) framebuffer; a rotated picture's point maps back into it. */
export function rawPoint(screen: DeviceScreen | undefined, x: number, y: number): {x: number; y: number} {
  if (!screen || screen.width > screen.height) return {x, y};
  switch (screen.orientation) {
    case 'landscape_left': return {x: y, y: 1 - x};
    case 'landscape_right': return {x: 1 - y, y: x};
    case 'portrait_upside_down': return {x: 1 - x, y: 1 - y};
    default: return {x, y};
  }
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);
