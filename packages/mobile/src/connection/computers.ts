/** Every computer this phone is paired with (#326 phase 4), each with its own link and keys. Screens get one connection per
 *  computer: the live one (which keeps the offline cache up to date) or, while the computer can't be reached, a stand-in that
 *  reads the cache. A computer that revokes this phone, or that the person unpairs here, has its cache wiped. */
import type {MobileAccess, MobileConnection, PairedRecord} from '../shared';
import {cachingConnection, offlineConnection} from '../offline/connection';
import {flushOutbox} from '../offline/outbox';
import type {OfflineCache} from '../offline/cache';
import {ComputerLink, type LinkPath} from './link';
import type {ComputerStore} from './store';

export interface ComputerView {
  id: string; name: string; path: LinkPath; access: MobileAccess | null;
  /** Live, or the cached stand-in while it can't be reached; null once revoked (or with nothing cached). */
  connection: MobileConnection | null;
  /** When the link went down (for "last seen"). */
  downSince?: number | null;
  error?: string;
}
export interface ComputersDeps { store: ComputerStore; cache: OfflineCache | null; connect(record: PairedRecord): Promise<MobileConnection>; heartbeat?: boolean }

export class Computers {
  private readonly links = new Map<string, ComputerLink>();
  private readonly offs = new Map<string, () => void>();
  private readonly wrapped = new WeakMap<MobileConnection, MobileConnection>();
  private readonly standIns = new Map<string, MobileConnection>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ComputerView[] = [];
  constructor(private readonly deps: ComputersDeps) {}

  async load(): Promise<void> { for (const record of await this.deps.store.list()) this.start(record); this.changed(); }
  /** A computer just paired (its record is already saved): connect to it, replacing an older pairing with it. */
  add(record: PairedRecord): void { this.drop(record.route); this.start(record); this.changed(); }
  /** Unpair on this phone: forget its keys and everything cached from it. */
  async remove(id: string): Promise<void> {
    this.drop(id);
    await this.deps.store.remove(id);
    this.deps.cache?.wipe(id);
    this.changed();
  }
  retry(id?: string): void { for (const [key, link] of this.links) if (!id || key === id) link.retry(); }
  views = (): ComputerView[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  dispose(): void { for (const id of [...this.links.keys()]) this.drop(id); this.listeners.clear(); }

  private start(record: PairedRecord): void {
    const {cache, store} = this.deps;
    const link = new ComputerLink(record, {
      connect: this.deps.connect,
      ...(this.deps.heartbeat === false ? {heartbeat: false} : {}),
      onRecord: next => { void store.save(next); },
      onConnected: connection => {
        if (cache) void flushOutbox(this.connectionFor(link, connection), cache, record.route);
      },
    });
    let wiped = false;
    this.offs.set(record.route, link.subscribe(() => {
      // Revoked on the computer: nothing it ever sent stays on this phone.
      if (link.state.path === 'revoked' && !wiped) { wiped = true; cache?.wipe(record.route); }
      this.changed();
    }));
    this.links.set(record.route, link);
    link.start();
  }
  private drop(id: string): void {
    this.offs.get(id)?.(); this.offs.delete(id);
    this.links.get(id)?.stop(); this.links.delete(id);
    this.standIns.delete(id);
  }
  private connectionFor(link: ComputerLink, live: MobileConnection): MobileConnection {
    const {cache} = this.deps;
    if (!cache) return live;
    let wrapped = this.wrapped.get(live);
    if (!wrapped) { wrapped = cachingConnection(live, {computerId: link.id, name: link.state.record.desktopName, cache}); this.wrapped.set(live, wrapped); }
    return wrapped;
  }
  private standIn(link: ComputerLink): MobileConnection | null {
    const {cache} = this.deps;
    if (!cache) return null;
    let connection = this.standIns.get(link.id);
    if (!connection) { connection = offlineConnection({computerId: link.id, name: link.state.record.desktopName, cache, retry: () => link.retry()}); this.standIns.set(link.id, connection); }
    return connection;
  }
  private changed(): void {
    this.snapshot = [...this.links.values()].map(link => {
      const {state} = link;
      const connection = state.connection ? this.connectionFor(link, state.connection) : state.path === 'revoked' ? null : this.standIn(link);
      return {id: link.id, name: state.record.desktopName, path: state.path, access: state.connection?.access ?? null, connection,
        downSince: state.downSince, ...(state.error ? {error: state.error} : {})};
    });
    for (const listener of [...this.listeners]) listener();
  }
}
