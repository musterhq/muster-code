/**
 * Coalesces `state()` snapshot emits. The first request in a quiet period emits at once; requests inside the
 * window collapse into one trailing emit carrying the latest state. `flush()` emits a pending one immediately
 * (a command's reply must never overtake the snapshot that already contains its change).
 */
export function createSnapshotCoalescer(emitNow: () => void, windowMs = 80) {
  let timer: ReturnType<typeof setTimeout> | undefined, pending = false, disposed = false;
  const open = () => {
    timer = setTimeout(() => { timer = undefined; if (pending && !disposed) { pending = false; emitNow(); open(); } }, windowMs);
    timer.unref?.();
  };
  return {
    request(): void {
      if (disposed) return;
      if (timer) { pending = true; return; }
      emitNow(); open();
    },
    flush(): void {
      if (!pending || disposed) return;
      pending = false; if (timer) clearTimeout(timer);
      emitNow(); open();
    },
    dispose(): void { disposed = true; if (timer) clearTimeout(timer); timer = undefined; pending = false; },
  };
}
