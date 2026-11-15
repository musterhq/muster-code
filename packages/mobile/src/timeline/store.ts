/**
 * The open chat's items, one entry per item (#326 phase 3). Rows subscribe to their own item and the list subscribes to the
 * ordered ids, so a streaming token re-renders one row, not the timeline. Changes are applied to the data at once (so a
 * missed delta is noticed at once) and announced once per frame, so a burst of tokens costs one render.
 */
import type {MobileItem, MobileItemOp} from '../shared';

type Listener = () => void;
const nextFrame: (run: () => void) => void = typeof requestAnimationFrame === 'function' ? run => { requestAnimationFrame(() => run()); } : run => { setTimeout(run, 16); };

export class TimelineStore {
  private ids: string[] = [];
  private readonly byId = new Map<string, MobileItem>();
  private readonly idListeners = new Set<Listener>();
  private readonly itemListeners = new Map<string, Set<Listener>>();
  private dirty = new Set<string>();
  private idsDirty = false;
  private scheduled = false;

  getIds = (): readonly string[] => this.ids;
  getItem = (id: string): MobileItem | undefined => this.byId.get(id);
  /** The newest item, for "is a reply streaming" and similar. */
  last = (): MobileItem | undefined => this.byId.get(this.ids[this.ids.length - 1] ?? '');
  subscribeIds = (listener: Listener): (() => void) => { this.idListeners.add(listener); return () => { this.idListeners.delete(listener); }; };
  subscribeItem = (id: string, listener: Listener): (() => void) => {
    let set = this.itemListeners.get(id);
    if (!set) { set = new Set(); this.itemListeners.set(id, set); }
    set.add(listener);
    return () => { set!.delete(listener); if (!set!.size) this.itemListeners.delete(id); };
  };

  /** Replaces everything (chat.open, a resync). Announced at once. */
  reset(items: readonly MobileItem[]): void {
    this.byId.clear();
    for (const item of items) this.byId.set(item.id, item);
    this.ids = items.map(item => item.id);
    this.dirty = new Set(this.itemListeners.keys());
    this.idsDirty = true;
    this.flush();
  }
  /** Applies one delta's ops. False when an op appends to an item this store does not have: the phone is out of step. */
  apply(ops: readonly MobileItemOp[]): boolean {
    for (const op of ops) {
      if ('item' in op) { this.put(op.item); continue; }
      if ('remove' in op) {
        if (this.byId.delete(op.remove)) { this.ids = this.ids.filter(id => id !== op.remove); this.idsDirty = true; this.dirty.add(op.remove); }
        continue;
      }
      const before = this.byId.get(op.id);
      if (!before) return false;
      this.byId.set(op.id, {...before, ...(op.append ? {text: before.text + op.append} : {}), ...(op.status !== undefined ? {status: op.status} : {})});
      this.dirty.add(op.id);
    }
    this.schedule();
    return true;
  }
  /** Whole items (from a phase 1 desktop's items events): new ones are appended, known ones replaced. */
  upsert(items: readonly MobileItem[]): void { for (const item of items) this.put(item); this.schedule(); }

  private put(item: MobileItem): void {
    if (!this.byId.has(item.id)) { this.ids = [...this.ids, item.id]; this.idsDirty = true; }
    this.byId.set(item.id, item);
    this.dirty.add(item.id);
  }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    nextFrame(() => { this.scheduled = false; this.flush(); });
  }
  private flush(): void {
    const dirty = this.dirty, idsDirty = this.idsDirty;
    this.dirty = new Set(); this.idsDirty = false;
    for (const id of dirty) for (const listener of [...(this.itemListeners.get(id) ?? [])]) listener();
    if (idsDirty) for (const listener of [...this.idListeners]) listener();
  }
}
