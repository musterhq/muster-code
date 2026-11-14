/** One paired computer's link (#326 phase 4): connects, reconnects with backoff, runs the heartbeat, and says how the phone
 *  reaches the computer right now, which the computer pill shows. A link that drops reads Reconnecting; it reads Offline
 *  only once it has been down for 3 seconds, so a blip never flashes the pill. Only the computer's revoked close ends it. */
import {MobileError, type MobileConnection, type PairedRecord} from '../shared';
import {afterLinkClose, afterLinkFailure, backoff} from './reconnect';
import {startHeartbeat, type Heartbeat} from './heartbeat';

export type LinkPath = 'connecting' | 'lan' | 'relay' | 'reconnecting' | 'offline' | 'revoked';
export interface LinkSnapshot { path: LinkPath; record: PairedRecord; connection: MobileConnection | null; error?: string; downSince: number | null }
export interface LinkDeps { connect(record: PairedRecord): Promise<MobileConnection>; heartbeat?: boolean; onConnected?(connection: MobileConnection): void; /** The record changed (new direct addresses): save it. */ onRecord?(record: PairedRecord): void }
export const OFFLINE_AFTER_MS = 3000;

export class ComputerLink {
  state: LinkSnapshot;
  private readonly listeners = new Set<() => void>();
  private attempt = 0;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private beat: Heartbeat | null = null;
  private stopped = false;

  constructor(record: PairedRecord, private readonly deps: LinkDeps) { this.state = {path: 'connecting', record, connection: null, downSince: null}; }
  get id(): string { return this.state.record.route; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  start(): void { this.stopped = false; this.connect(); }
  /** Try now (Retry, the app came back): no backoff wait. */
  retry(): void {
    if (this.state.connection) { this.beat?.check(); return; }
    if (this.state.path === 'revoked' || this.stopped) return;
    this.attempt = 0; this.connect();
  }
  stop(): void {
    this.stopped = true; this.generation++;
    clearTimeout(this.retryTimer); clearTimeout(this.offlineTimer);
    this.beat?.stop(); this.state.connection?.close();
    this.set({connection: null});
  }

  private set(change: Partial<LinkSnapshot>): void { this.state = {...this.state, ...change}; for (const listener of [...this.listeners]) listener(); }
  /** The link went down (or never came up): Reconnecting now, Offline if it is still down 3 seconds later. */
  private down(error?: string): void {
    const downSince = this.state.downSince ?? Date.now();
    const path: LinkPath = this.state.path === 'offline' ? 'offline' : this.state.path === 'connecting' ? 'connecting' : 'reconnecting';
    this.set({path, connection: null, downSince, ...(error ? {error} : {})});
    if (path !== 'offline' && !this.offlineTimer) {
      this.offlineTimer = setTimeout(() => { this.offlineTimer = undefined; if (!this.state.connection && this.state.path !== 'revoked' && !this.stopped) this.set({path: 'offline'}); }, Math.max(0, downSince + OFFLINE_AFTER_MS - Date.now()));
    }
  }
  private later(): void { if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), backoff(this.attempt++)); }
  private revoked(): void { clearTimeout(this.offlineTimer); this.offlineTimer = undefined; this.set({path: 'revoked', connection: null}); }

  private connect(): void {
    clearTimeout(this.retryTimer);
    const mine = ++this.generation;
    const stale = () => this.generation !== mine || this.stopped;
    this.state.connection?.close();
    this.down();
    this.deps.connect(this.state.record).then(connection => {
      if (stale()) { connection.close(); return; }
      this.attempt = 0;
      clearTimeout(this.offlineTimer); this.offlineTimer = undefined;
      let record = this.state.record;
      // The desktop's hello names its current direct addresses; keep them so the next connection on its network skips the relay.
      if (connection.lan && connection.lan.join() !== (record.lan ?? []).join()) {
        const {lan: _old, ...rest} = record;
        record = connection.lan.length ? {...rest, lan: connection.lan} : rest;
      }
      if (record !== this.state.record) this.deps.onRecord?.(record);
      const {error: _error, ...rest} = this.state;
      this.state = {...rest, record, connection, downSince: null, path: connection.via === 'lan' ? 'lan' : 'relay'};
      this.set({});
      this.deps.onConnected?.(connection);
      /** The heartbeat found the link dead: reconnect without waiting out a backoff. */
      let silent = false;
      this.beat?.stop();
      const beat = this.deps.heartbeat === false ? null : startHeartbeat(connection, {onDead: () => { silent = true; connection.close(); }});
      this.beat = beat;
      connection.onClose(reason => {
        beat?.stop();
        if (stale()) return;
        // Only the desktop's revoked close shows revoked; a network error or bad frame reconnects. The record is kept.
        if (afterLinkClose(reason) === 'revoked') { this.revoked(); return; }
        this.set({path: 'reconnecting'});
        this.down();
        if (silent) this.connect(); else this.later();
      });
    }, (error: unknown) => {
      if (stale()) return;
      if (afterLinkFailure(error) === 'revoked') { this.revoked(); return; }
      this.down(error instanceof MobileError || error instanceof Error ? error.message : String(error));
      this.later();
    });
  }
}
