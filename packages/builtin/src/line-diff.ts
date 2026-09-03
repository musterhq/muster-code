// Line-level diff (Myers) between a baseline and a target: the hunks that the
// live inline diff paints. Common prefix/suffix are trimmed first so the O(ND)
// search only sees the changed middle; pathological diffs fall back to one
// replace hunk rather than exploding memory.
export interface LineHunk {
  /** First baseline line replaced (0-based) and how many. */
  readonly baseStart: number;
  readonly baseCount: number;
  /** First target line of the replacement (0-based) and how many. */
  readonly targetStart: number;
  readonly targetCount: number;
  /** The baseline lines this hunk removes, in order. */
  readonly removed: string[];
}

export function lineDiff(base: readonly string[], target: readonly string[]): LineHunk[] {
  let prefix = 0;
  while (prefix < base.length && prefix < target.length && base[prefix] === target[prefix]) prefix++;
  let suffix = 0;
  while (suffix < base.length - prefix && suffix < target.length - prefix && base[base.length - 1 - suffix] === target[target.length - 1 - suffix]) suffix++;
  const a = base.slice(prefix, base.length - suffix);
  const b = target.slice(prefix, target.length - suffix);
  const hunks: { baseStart: number; baseCount: number; targetStart: number; targetCount: number; removed: string[] }[] = [];
  let i = 0;
  let j = 0;
  let current: (typeof hunks)[number] | undefined;
  for (const op of myers(a, b)) {
    if (op === "=") { current = undefined; i++; j++; continue; }
    if (!current) { current = { baseStart: prefix + i, baseCount: 0, targetStart: prefix + j, targetCount: 0, removed: [] }; hunks.push(current); }
    if (op === "-") { current.removed.push(a[i]!); current.baseCount++; i++; } else { current.targetCount++; j++; }
  }
  return hunks;
}

function myers(a: readonly string[], b: readonly string[]): ("=" | "-" | "+")[] {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return new Array<"+">(m).fill("+");
  if (!m) return new Array<"-">(n).fill("-");
  const max = n + m;
  const width = 2 * max + 2;
  const cap = Math.min(max, Math.max(64, Math.floor(24_000_000 / width)));
  const off = max;
  const v = new Int32Array(width);
  v[off + 1] = 0;
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= cap; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break outer; }
    }
  }
  if (!found) return [...new Array<"-">(n).fill("-"), ...new Array<"+">(m).fill("+")];
  const ops: ("=" | "-" | "+")[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && snapshot[off + k - 1]! < snapshot[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = snapshot[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push("="); x--; y--; }
    if (d > 0) {
      if (x === prevX) { ops.push("+"); y--; } else { ops.push("-"); x--; }
    }
  }
  return ops.reverse();
}

/** Apply one hunk to the baseline lines (accepting it moves the baseline forward). */
export function applyHunk(base: readonly string[], target: readonly string[], hunk: LineHunk): string[] {
  return [...base.slice(0, hunk.baseStart), ...target.slice(hunk.targetStart, hunk.targetStart + hunk.targetCount), ...base.slice(hunk.baseStart + hunk.baseCount)];
}
