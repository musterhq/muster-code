import type {TimelineItem, TimelinePatch, TimelineSnapshot} from '../shared/protocol.ts';

/** Snapshot + ordered deltas, following T3's thread reducer approach. Completed
 * rows retain their identities; gaps request an authoritative snapshot. The
 * bounded pending queue also covers events arriving during the initial read. */
export class TimelineReplica {
  value?: TimelineSnapshot;
  private pending: TimelinePatch[] = [];
  private requiredRevision = 0;
  private indices = new Map<string, number>();

  get needsSnapshot(): boolean {
    return !this.value || this.value.revision < this.requiredRevision || this.pending.length > 0;
  }

  patch(patch: TimelinePatch): void {
    if (this.value && patch.revision <= this.value.revision) return;
    if (!this.value || patch.after > this.value.revision) {
      if (this.pending.length >= 64) {
        this.requiredRevision = Math.max(this.requiredRevision, ...this.pending.map(item => item.revision));
        this.pending = [];
      }
      this.pending.push(patch);
      return;
    }
    this.apply(patch);
    this.drain();
  }

  snapshot(snapshot: TimelineSnapshot): void {
    if (!this.value || snapshot.revision >= this.value.revision) {
      this.value = snapshot;
      this.indices = new Map(snapshot.items.map((item, index) => [item.id, index]));
    }
    this.drain();
  }

  private apply(patch: TimelinePatch): void {
    const previous = this.value!;
    let items = previous.items;
    if (patch.items.length) {
      items = items.slice();
      for (const item of patch.items) {
        const index = this.indices.get(item.id);
        if (index === undefined) { this.indices.set(item.id, items.length); items.push(item); }
        else items[index] = item;
      }
    }
    this.value = {items, revision: patch.revision};
  }

  private drain(): void {
    // IPC preserves order, but a snapshot response can race its events. Sorting
    // only the small pending window makes recovery independent of that race.
    this.pending.sort((a, b) => a.revision - b.revision);
    const pending = this.pending;
    this.pending = [];
    for (const patch of pending) {
      if (this.value && patch.revision <= this.value.revision) continue;
      if (this.value && patch.after <= this.value.revision) this.apply(patch);
      else this.pending.push(patch);
    }
  }
}
