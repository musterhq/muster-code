// Incremental parser for Codex's apply_patch text as it STREAMS (the
// `item/fileChange/outputDelta` payload). Feed deltas; read the per-file
// partial result at any moment to paint the editor mid-generation.
//
//   *** Begin Patch
//   *** Update File: src/server.js
//   @@ function createTodoServer(
//    context line
//   -removed line
//   +added line
//   *** Add File: docs/NEW.md
//   +content
//   *** Delete File: old.txt
//   *** End Patch

export type PatchOp = "update" | "add" | "delete";

export interface PatchHunkLine { readonly kind: " " | "+" | "-"; readonly text: string }
export interface PatchHunk { readonly header: string; readonly lines: PatchHunkLine[] }
export interface PatchFile { readonly op: PatchOp; readonly path: string; readonly movePath?: string; readonly hunks: PatchHunk[]; complete: boolean }

export class ApplyPatchStream {
  private buffer = "";
  private consumed = 0;
  readonly files: PatchFile[] = [];
  private current: PatchFile | undefined;

  /** Append streamed text; returns the files touched by newly parsed lines. */
  push(delta: string): PatchFile[] {
    this.buffer += delta;
    const touched = new Set<PatchFile>();
    let newline = this.buffer.indexOf("\n", this.consumed);
    while (newline >= 0) {
      const line = this.buffer.slice(this.consumed, newline);
      this.consumed = newline + 1;
      const file = this.consumeLine(line);
      if (file) touched.add(file);
      newline = this.buffer.indexOf("\n", this.consumed);
    }
    // The in-progress (unterminated) line still paints: Cursor shows words as they land.
    const tail = this.buffer.slice(this.consumed);
    if (tail && this.current && this.current.hunks.length && /^[ +-]/.test(tail)) {
      const hunk = this.current.hunks[this.current.hunks.length - 1]!;
      const partial: PatchHunkLine = { kind: tail[0] as " " | "+" | "-", text: tail.slice(1) };
      this.partialLine = partial;
      touched.add(this.current);
    } else {
      this.partialLine = undefined;
    }
    return [...touched];
  }

  private partialLine: PatchHunkLine | undefined;

  private consumeLine(line: string): PatchFile | undefined {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      if (this.current) this.current.complete = true;
      this.current = undefined;
      return undefined;
    }
    const header = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (this.current) this.current.complete = true;
      const op = header[1]!.toLowerCase() as PatchOp;
      this.current = { op, path: header[2]!.trim(), hunks: [], complete: op === "delete" };
      this.files.push(this.current);
      return this.current;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && this.current) {
      (this.current as { movePath?: string }).movePath = move[1]!.trim();
      return this.current;
    }
    if (!this.current) return undefined;
    if (line.startsWith("@@")) {
      this.current.hunks.push({ header: line.slice(2).trim(), lines: [] });
      return this.current;
    }
    if (line === "" || /^[ +-]/.test(line)) {
      if (!this.current.hunks.length) this.current.hunks.push({ header: "", lines: [] });
      const hunk = this.current.hunks[this.current.hunks.length - 1]!;
      const kind = (line === "" ? " " : line[0]) as " " | "+" | "-";
      hunk.lines.push({ kind, text: line === "" ? "" : line.slice(1) });
      return this.current;
    }
    return undefined;
  }

  /**
   * Apply everything parsed so far for `file` to `baseline`, including the
   * partial trailing line. Context anchors locate each hunk (first match after
   * the previous hunk); unmatched hunks append at the end so nothing is lost.
   */
  render(file: PatchFile, baseline: string): string {
    if (file.op === "delete") return "";
    const base = file.op === "add" ? [] : baseline.split("\n");
    const out: string[] = [];
    let cursor = 0;
    const partial = this.current === file ? this.partialLine : undefined;
    file.hunks.forEach((hunk, hunkIndex) => {
      const lines = hunkIndex === file.hunks.length - 1 && partial ? [...hunk.lines, partial] : hunk.lines;
      const oldSide = lines.filter((l) => l.kind !== "+").map((l) => l.text);
      let start = -1;
      if (file.op === "update") {
        start = findAnchor(base, oldSide, cursor, hunk.header);
      }
      if (start < 0) start = base.length;
      out.push(...base.slice(cursor, start));
      for (const l of lines) if (l.kind !== "-") out.push(l.text);
      cursor = start + oldSide.length;
    });
    out.push(...base.slice(cursor));
    return out.join("\n");
  }
}

function findAnchor(base: readonly string[], oldSide: readonly string[], from: number, header: string): number {
  if (oldSide.length) {
    for (let i = from; i <= base.length - oldSide.length; i += 1) {
      let ok = true;
      for (let j = 0; j < oldSide.length; j += 1) if (base[i + j] !== oldSide[j]) { ok = false; break; }
      if (ok) return i;
    }
    // Partial first line during streaming: anchor on the first old line alone.
    const first = oldSide[0]!;
    for (let i = from; i < base.length; i += 1) if (base[i] === first) return i;
  }
  if (header) {
    for (let i = from; i < base.length; i += 1) if (base[i]!.includes(header)) return i + 1;
  }
  return -1;
}
