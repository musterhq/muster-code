/**
 * Parser for the "Local work log" issue document that Muster Agent keeps on a task it has
 * checked out. The document key is `local-work-log` (title "Local work log"). The body is
 * markdown with one `##` section per entry:
 *
 *   ## 2026-10-05T09:14:00Z · Add retry to the uploader
 *   - Device: Dhairya's MacBook
 *   - Files: +120 -34 (6 files)
 *   - Tests: 14 passed, 1 failed
 *   - Tokens: 12,400 in / 3,100 out
 *   - Model: claude-sonnet-5-5
 *   - Cost: $0.42 (personal)
 *   - Summary: Retries with backoff; added tests for the 429 path.
 *
 * An entry may instead be given as a fenced ```json block holding one object or an array of
 * objects with the field names of `WorkLogEntry`. Unknown bullets are kept in `extra`.
 */
export const WORK_LOG_DOCUMENT_KEY = "local-work-log";
export const WORK_LOG_DOCUMENT_TITLE = "Local work log";

export type CostSource = "personal" | "org" | "unknown";

export interface WorkLogEntry {
  heading: string;
  at: string | null;
  title: string | null;
  device: string | null;
  filesAdded: number | null;
  filesRemoved: number | null;
  filesChanged: number | null;
  tests: string | null;
  testsPassed: number | null;
  testsFailed: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensTotal: number | null;
  model: string | null;
  costUsd: number | null;
  costSource: CostSource;
  summary: string | null;
  extra: Record<string, string>;
}

function blankEntry(heading: string): WorkLogEntry {
  return {
    heading,
    at: null,
    title: null,
    device: null,
    filesAdded: null,
    filesRemoved: null,
    filesChanged: null,
    tests: null,
    testsPassed: null,
    testsFailed: null,
    tokensIn: null,
    tokensOut: null,
    tokensTotal: null,
    model: null,
    costUsd: null,
    costSource: "unknown",
    summary: null,
    extra: {},
  };
}

function num(text: string | undefined): number | null {
  if (!text) return null;
  const value = Number(text.replace(/[,_\s]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function parseFiles(value: string, entry: WorkLogEntry): void {
  const added = /\+\s*([\d,]+)/.exec(value);
  const removed = /[-−–]\s*([\d,]+)(?!\s*files?)/.exec(value);
  const count = /([\d,]+)\s*files?/i.exec(value) ?? /\(\s*([\d,]+)\s*\)/.exec(value);
  entry.filesAdded = num(added?.[1]);
  entry.filesRemoved = num(removed?.[1]);
  entry.filesChanged = num(count?.[1]);
}

function parseTests(value: string, entry: WorkLogEntry): void {
  entry.tests = value;
  entry.testsPassed = num(/([\d,]+)\s*(?:passed|pass|ok)/i.exec(value)?.[1]);
  entry.testsFailed = num(/([\d,]+)\s*(?:failed|fail|failing)/i.exec(value)?.[1]);
}

function parseTokens(value: string, entry: WorkLogEntry): void {
  const input = /([\d,]+)\s*(?:in|input|prompt)\b/i.exec(value);
  const output = /([\d,]+)\s*(?:out|output|completion)\b/i.exec(value);
  entry.tokensIn = num(input?.[1]);
  entry.tokensOut = num(output?.[1]);
  const total = /([\d,]+)\s*(?:total)?\s*$/i.exec(value.trim());
  if (entry.tokensIn !== null || entry.tokensOut !== null) {
    entry.tokensTotal = (entry.tokensIn ?? 0) + (entry.tokensOut ?? 0);
  } else {
    entry.tokensTotal = num(total?.[1]);
  }
}

function parseCostSource(value: string): CostSource {
  if (/personal|own|subscription|local key/i.test(value)) return "personal";
  if (/\borg\b|organi[sz]ation|company|shared/i.test(value)) return "org";
  return "unknown";
}

function parseCost(value: string, entry: WorkLogEntry): void {
  entry.costUsd = num(/\$\s*([\d,]*\.?\d+)/.exec(value)?.[1] ?? /^([\d,]*\.?\d+)/.exec(value.trim())?.[1]);
  const source = parseCostSource(value);
  if (source !== "unknown") entry.costSource = source;
}

function applyField(entry: WorkLogEntry, rawKey: string, value: string): void {
  const key = normalizeKey(rawKey);
  switch (key) {
    case "device":
    case "machine":
      entry.device = value;
      return;
    case "files":
    case "file changes":
      parseFiles(value, entry);
      return;
    case "tests":
    case "test":
      parseTests(value, entry);
      return;
    case "tokens":
      parseTokens(value, entry);
      return;
    case "model":
      entry.model = value;
      return;
    case "cost":
      parseCost(value, entry);
      return;
    case "cost source":
    case "billing":
      entry.costSource = parseCostSource(value);
      return;
    case "summary":
    case "notes":
      entry.summary = value;
      return;
    case "time":
    case "at":
    case "when":
      entry.at = value;
      return;
    case "task":
    case "title":
      entry.title = value;
      return;
    default:
      entry.extra[rawKey.trim()] = value;
  }
}

function splitHeading(heading: string, entry: WorkLogEntry): void {
  const parts = heading.split(/\s+[·—–|]\s+|\s+-\s+/);
  const first = parts[0]?.trim() ?? "";
  if (/^\d{4}-\d{2}-\d{2}/.test(first)) {
    entry.at = first;
    entry.title = parts.slice(1).join(" · ").trim() || null;
  } else {
    entry.title = heading.trim() || null;
  }
}

function fromJsonObject(raw: Record<string, unknown>, index: number): WorkLogEntry {
  const entry = blankEntry(typeof raw.title === "string" ? raw.title : `Entry ${index + 1}`);
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const numeric = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  entry.at = str(raw.at);
  entry.title = str(raw.title);
  entry.device = str(raw.device);
  entry.filesAdded = numeric(raw.filesAdded);
  entry.filesRemoved = numeric(raw.filesRemoved);
  entry.filesChanged = numeric(raw.filesChanged);
  entry.tests = str(raw.tests);
  entry.testsPassed = numeric(raw.testsPassed);
  entry.testsFailed = numeric(raw.testsFailed);
  entry.tokensIn = numeric(raw.tokensIn);
  entry.tokensOut = numeric(raw.tokensOut);
  entry.tokensTotal = numeric(raw.tokensTotal) ?? (entry.tokensIn !== null || entry.tokensOut !== null ? (entry.tokensIn ?? 0) + (entry.tokensOut ?? 0) : null);
  entry.model = str(raw.model);
  entry.costUsd = numeric(raw.costUsd);
  entry.costSource = raw.costSource === "personal" || raw.costSource === "org" ? raw.costSource : "unknown";
  entry.summary = str(raw.summary);
  return entry;
}

function parseJsonBlocks(body: string): WorkLogEntry[] {
  const entries: WorkLogEntry[] = [];
  for (const match of body.matchAll(/```json\s*\n([\s\S]*?)```/gi)) {
    try {
      const parsed: unknown = JSON.parse(match[1]!);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item && typeof item === "object") entries.push(fromJsonObject(item as Record<string, unknown>, entries.length));
      }
    } catch {
      // A malformed block is skipped; the markdown sections still parse.
    }
  }
  return entries;
}

export function parseWorkLog(body: string | null | undefined): WorkLogEntry[] {
  if (!body) return [];
  const withoutJson = body.replace(/```json\s*\n[\s\S]*?```/gi, "");
  const entries: WorkLogEntry[] = [];
  let current: WorkLogEntry | null = null;
  for (const line of withoutJson.split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      current = blankEntry(heading[1]!);
      splitHeading(heading[1]!, current);
      entries.push(current);
      continue;
    }
    const bullet = /^\s*[-*]\s+\**([^:*]+?)\**\s*:\s*(.+?)\s*$/.exec(line);
    if (bullet && current) applyField(current, bullet[1]!, bullet[2]!);
  }
  entries.push(...parseJsonBlocks(body));
  return entries.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

export interface WorkLogTotals {
  entries: number;
  filesAdded: number;
  filesRemoved: number;
  tokensTotal: number;
  costPersonalUsd: number;
  costOrgUsd: number;
  costUnknownUsd: number;
}

export function totalsOf(entries: WorkLogEntry[]): WorkLogTotals {
  const totals: WorkLogTotals = {
    entries: entries.length,
    filesAdded: 0,
    filesRemoved: 0,
    tokensTotal: 0,
    costPersonalUsd: 0,
    costOrgUsd: 0,
    costUnknownUsd: 0,
  };
  for (const entry of entries) {
    totals.filesAdded += entry.filesAdded ?? 0;
    totals.filesRemoved += entry.filesRemoved ?? 0;
    totals.tokensTotal += entry.tokensTotal ?? 0;
    const cost = entry.costUsd ?? 0;
    if (entry.costSource === "personal") totals.costPersonalUsd += cost;
    else if (entry.costSource === "org") totals.costOrgUsd += cost;
    else totals.costUnknownUsd += cost;
  }
  return totals;
}

/** One line for the issue tab: the latest entry's own summary, else a composed digest. */
export function summarizeLatest(entries: WorkLogEntry[]): string | null {
  const latest = entries[entries.length - 1];
  if (!latest) return null;
  if (latest.summary) return latest.summary;
  const bits: string[] = [];
  if (latest.filesChanged !== null) bits.push(`${latest.filesChanged} file${latest.filesChanged === 1 ? "" : "s"}`);
  if (latest.tests) bits.push(`tests ${latest.tests}`);
  if (latest.title) bits.unshift(latest.title);
  return bits.length > 0 ? bits.join(", ") : latest.heading;
}
