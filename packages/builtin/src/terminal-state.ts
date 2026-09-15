/** Pure helpers for the managed terminal registry. These deliberately operate on text only. */
export const DEFAULT_TERMINAL_OUTPUT_BYTES = 40_000;

export function boundedText(value: string, maxBytes = DEFAULT_TERMINAL_OUTPUT_BYTES): string {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_TERMINAL_OUTPUT_BYTES;
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= limit ? value : bytes.subarray(bytes.length - limit).toString("utf8");
}

export interface OutputMatch { line: number; text: string; index: number }

export function searchText(value: string, query: string, options: { limit?: number; caseSensitive?: boolean } = {}): OutputMatch[] {
  const needle = query.trim(); if (!needle) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  const haystack = options.caseSensitive ? value : value.toLocaleLowerCase();
  const target = options.caseSensitive ? needle : needle.toLocaleLowerCase();
  const matches: OutputMatch[] = [];
  let from = 0;
  while (matches.length < limit) {
    const index = haystack.indexOf(target, from); if (index < 0) break;
    const line = value.slice(0, index).split("\n").length;
    const start = value.lastIndexOf("\n", index - 1) + 1;
    const end = value.indexOf("\n", index); matches.push({ line, text: value.slice(start, end < 0 ? value.length : end), index });
    from = Math.max(index + target.length, index + 1);
  }
  return matches;
}
