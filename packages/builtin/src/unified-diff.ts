// Unified diffs as Codex reports them per turn (turn/diff/updated): parse per file,
// and reverse-apply to reconstruct a file's turn-start contents from its current
// contents. This is how edits made through shell commands still get the inline diff.
export interface UnifiedHunk { readonly oldStart: number; readonly lines: { kind: " " | "+" | "-"; text: string }[] }
export interface UnifiedFile { readonly path: string; readonly oldPath: string | null; readonly hunks: UnifiedHunk[] }

export function parseUnifiedDiff(diff: string): UnifiedFile[] {
  const files: UnifiedFile[] = [];
  let current: { path: string; oldPath: string | null; hunks: UnifiedHunk[] } | undefined;
  let hunk: { oldStart: number; lines: { kind: " " | "+" | "-"; text: string }[] } | undefined;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) { current = undefined; hunk = undefined; continue; }
    if (raw.startsWith("--- ")) { const p = strip(raw.slice(4)); current = { path: "", oldPath: p === "/dev/null" ? null : p, hunks: [] }; hunk = undefined; continue; }
    if (raw.startsWith("+++ ")) { const p = strip(raw.slice(4)); if (!current) current = { path: p, oldPath: null, hunks: [] }; else current = { ...current, path: p === "/dev/null" ? (current.oldPath ?? "") : p }; files.push(current); continue; }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header && current) { hunk = { oldStart: Number(header[1]), lines: [] }; current.hunks.push(hunk); continue; }
    if (!hunk) continue;
    if (raw.startsWith("\\ No newline")) continue;
    const kind = raw[0];
    if (kind === " " || kind === "+" || kind === "-") hunk.lines.push({ kind, text: raw.slice(1) });
    else if (raw === "") hunk.lines.push({ kind: " ", text: "" });
  }
  return files.filter((f) => f.path);
}

function strip(p: string): string {
  const path = p.trim().split("\t")[0] ?? "";
  return path.replace(/^[ab]\//, "");
}

/** Given the file as it is now (after the diff), return how it was before the diff. */
export function reverseApply(current: string, file: UnifiedFile): string {
  const lines = current.split("\n");
  const out: string[] = [];
  let cursor = 0;
  // Hunk positions in the NEW file are implied by the order and the +/context lines consumed so far.
  let newOffset = 0;
  for (const hunk of file.hunks) {
    const newStart = hunk.oldStart - 1 + newOffset;
    const anchor = findAnchor(lines, hunk, newStart);
    while (cursor < anchor && cursor < lines.length) out.push(lines[cursor++]!);
    for (const line of hunk.lines) {
      if (line.kind === " ") { out.push(line.text); cursor++; }
      else if (line.kind === "-") out.push(line.text);
      else cursor++;
    }
    newOffset += hunk.lines.filter((l) => l.kind === "+").length - hunk.lines.filter((l) => l.kind === "-").length;
  }
  while (cursor < lines.length) out.push(lines[cursor++]!);
  return out.join("\n");
}

function findAnchor(lines: string[], hunk: UnifiedHunk, guess: number): number {
  const probe = hunk.lines.filter((l) => l.kind !== "-").map((l) => l.text);
  if (!probe.length) return Math.max(0, Math.min(guess, lines.length));
  const matches = (at: number) => probe.every((text, i) => lines[at + i] === text);
  for (let delta = 0; delta < 400; delta++) {
    for (const at of [guess + delta, guess - delta]) if (at >= 0 && at + probe.length <= lines.length && matches(at)) return at;
  }
  return Math.max(0, Math.min(guess, lines.length));
}
