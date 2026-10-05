import type { PluginContext } from "@paperclipai/plugin-sdk";
import { buildMarker } from "./markers.js";
import { deriveCheckout, idleMs, reminderDue, type CheckoutState } from "./checkout.js";
import {
  WORK_LOG_DOCUMENT_KEY,
  WORK_LOG_DOCUMENT_TITLE,
  parseWorkLog,
  summarizeLatest,
  totalsOf,
  type WorkLogEntry,
  type WorkLogTotals,
} from "./worklog.js";

export const DEFAULT_LEASE_EXPIRY_HOURS = 24;
const CHECKOUT_SCAN_STATUSES = ["in_progress", "todo", "blocked"] as const;
const MENTION_SCAN_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const MENTION_SCAN_LIMIT = 40;
const MENTION_RESULT_LIMIT = 20;
const SCAN_CONCURRENCY = 6;

export interface PluginSettings {
  leaseExpiryHours: number;
}

export function readSettings(raw: Record<string, unknown> | null | undefined): PluginSettings {
  const value = Number(raw?.leaseExpiryHours);
  return {
    leaseExpiryHours: Number.isFinite(value) && value >= 1 ? value : DEFAULT_LEASE_EXPIRY_HOURS,
  };
}

/** Link the "Open in Muster" button points at. `host` is appended by the UI (the Paperclip origin). */
export function deepLinkFor(companyId: string, issueId: string): string {
  return `muster://task/${encodeURIComponent(companyId)}/${encodeURIComponent(issueId)}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

async function liveComments(ctx: PluginContext, companyId: string, issueId: string) {
  const comments = await ctx.issues.listComments(issueId, companyId);
  return comments.filter((comment) => !comment.deletedAt);
}

export interface WorkLogView {
  documentKey: string;
  updatedAt: string | null;
  entries: WorkLogEntry[];
  totals: WorkLogTotals;
  summary: string | null;
}

export async function loadWorkLog(ctx: PluginContext, companyId: string, issueId: string): Promise<WorkLogView | null> {
  const documents = await ctx.issues.documents.list(issueId, companyId);
  const match =
    documents.find((doc) => doc.key === WORK_LOG_DOCUMENT_KEY) ??
    documents.find((doc) => (doc.title ?? "").trim().toLowerCase() === WORK_LOG_DOCUMENT_TITLE.toLowerCase());
  if (!match) return null;
  const document = await ctx.issues.documents.get(issueId, match.key, companyId);
  if (!document) return null;
  const entries = parseWorkLog(document.body);
  return {
    documentKey: match.key,
    updatedAt: match.updatedAt ? new Date(match.updatedAt).toISOString() : null,
    entries,
    totals: totalsOf(entries),
    summary: summarizeLatest(entries),
  };
}

export interface IssueMusterView {
  issueId: string;
  identifier: string | null;
  title: string | null;
  checkout: CheckoutState;
  deepLink: string;
  workLog: { summary: string | null; entryCount: number; updatedAt: string | null } | null;
  leaseExpiryHours: number;
}

export async function loadIssueMuster(ctx: PluginContext, companyId: string, issueId: string): Promise<IssueMusterView> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) throw new Error("Issue not found");
  const [comments, workLog, config] = await Promise.all([
    liveComments(ctx, companyId, issueId),
    loadWorkLog(ctx, companyId, issueId),
    ctx.config.get(companyId),
  ]);
  return {
    issueId,
    identifier: issue.identifier ?? null,
    title: issue.title ?? null,
    checkout: deriveCheckout(issue, comments),
    deepLink: deepLinkFor(companyId, issueId),
    workLog: workLog ? { summary: workLog.summary, entryCount: workLog.entries.length, updatedAt: workLog.updatedAt } : null,
    leaseExpiryHours: readSettings(config).leaseExpiryHours,
  };
}

export interface MentionItem {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  projectId: string | null;
  commentId: string;
  at: string;
  snippet: string;
}

export interface MyWorkExtras {
  checkouts: Record<string, CheckoutState>;
  mentions: MentionItem[];
}

function snippetOf(body: string): string {
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[([^\]]*)\]\(user:\/\/[^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

export async function loadMyWorkExtras(
  ctx: PluginContext,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<MyWorkExtras> {
  const ids = [...new Set(issueIds)].slice(0, 100);
  const checkouts: Record<string, CheckoutState> = {};
  await mapLimit(ids, SCAN_CONCURRENCY, async (issueId) => {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return;
    checkouts[issueId] = deriveCheckout(issue, await liveComments(ctx, companyId, issueId));
  });

  const mine = new Set(ids);
  const candidates = (
    await Promise.all(
      MENTION_SCAN_STATUSES.map((status) => ctx.issues.list({ companyId, status, limit: 50 })),
    )
  )
    .flat()
    .filter((issue) => !mine.has(issue.id))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MENTION_SCAN_LIMIT);

  const needle = `](user://${userId})`;
  const found: MentionItem[] = [];
  await mapLimit(candidates, SCAN_CONCURRENCY, async (issue) => {
    const comments = await liveComments(ctx, companyId, issue.id);
    const hit = [...comments].reverse().find((comment) => comment.body.includes(needle));
    if (!hit) return;
    found.push({
      issueId: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      status: issue.status,
      projectId: issue.projectId ?? null,
      commentId: hit.id,
      at: new Date(hit.createdAt).toISOString(),
      snippet: snippetOf(hit.body),
    });
  });
  found.sort((a, b) => b.at.localeCompare(a.at));
  return { checkouts, mentions: found.slice(0, MENTION_RESULT_LIMIT) };
}

export function reminderBody(state: CheckoutState, idleHours: number, limitHours: number): string {
  const who = state.userLabel ? `@${state.userLabel}` : "@assignee";
  const mention = `[${who}](user://${state.userId})`;
  const device = state.device ? ` on ${state.device}` : "";
  return [
    `${mention} Your Muster check-out${device} has had no activity for ${idleHours} h (reminder after ${limitHours} h).`,
    "",
    "Post an update from Muster to keep working on it, or hand the task back so someone else can pick it up. Muster does not reassign tasks on its own.",
    "",
    buildMarker("reminder", { after: state.lastActivityAt ?? undefined }),
  ].join("\n");
}

export interface ExpiryResult {
  companies: number;
  scanned: number;
  checkedOut: number;
  reminded: Array<{ companyId: string; issueId: string }>;
  /** Companies the host refused to scope the job to (the operator has not saved Muster settings there). */
  skipped: Array<{ companyId: string; reason: string }>;
}

async function remindCompany(ctx: PluginContext, companyId: string, now: Date, result: ExpiryResult): Promise<void> {
  // The host only grants a scheduled job access to companies whose plugin settings were saved at least
  // once, so this first call is also the "is this company enabled" probe.
  const settings = readSettings(await ctx.config.get(companyId));
  const seen = new Set<string>();
  for (const status of CHECKOUT_SCAN_STATUSES) {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await ctx.issues.list({ companyId, status, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      for (const issue of batch) {
        if (seen.has(issue.id) || !issue.assigneeUserId || issue.assigneeAgentId) continue;
        seen.add(issue.id);
        result.scanned += 1;
        const state = deriveCheckout(issue, await liveComments(ctx, companyId, issue.id));
        if (state.status !== "checked_out") continue;
        result.checkedOut += 1;
        if (!reminderDue(state, now, settings.leaseExpiryHours)) continue;
        const hours = Math.floor((idleMs(state, now) ?? 0) / 3_600_000);
        await ctx.issues.createComment(issue.id, reminderBody(state, hours, settings.leaseExpiryHours), companyId);
        result.reminded.push({ companyId, issueId: issue.id });
      }
      if (batch.length < PAGE_SIZE) break;
    }
  }
}

/**
 * One pass of the idle check-out reminder. For every issue that is checked out through Muster and
 * has had no Muster activity for the configured number of hours, post exactly one reminder comment
 * that @mentions the human assignee. It never changes the assignee or status.
 */
export async function runLeaseExpiry(ctx: PluginContext, now: Date = new Date()): Promise<ExpiryResult> {
  const result: ExpiryResult = { companies: 0, scanned: 0, checkedOut: 0, reminded: [], skipped: [] };
  const companies = await ctx.companies.list({ limit: 200 });
  for (const company of companies) {
    result.companies += 1;
    try {
      await remindCompany(ctx, company.id, now, result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.skipped.push({ companyId: company.id, reason });
      ctx.logger.warn("Muster lease-expiry skipped a company", { companyId: company.id, reason });
    }
  }
  ctx.logger.info("Muster lease-expiry pass finished", {
    companies: result.companies,
    scanned: result.scanned,
    checkedOut: result.checkedOut,
    reminded: result.reminded.length,
    skipped: result.skipped.length,
  });
  return result;
}
