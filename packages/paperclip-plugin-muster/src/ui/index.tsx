import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  useHostContext,
  useHostNavigation,
  usePluginData,
  type PluginDetailTabProps,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import type { CheckoutState } from "../lib/checkout.js";
import type { IssueMusterView, MyWorkExtras, WorkLogView } from "../lib/service.js";
import { absoluteTime, formatCount, formatUsd, openInMusterHref, relativeTime } from "./format.js";

const card: CSSProperties = {
  border: "1px solid var(--border, #d4d4d8)",
  borderRadius: 8,
  padding: 16,
  background: "var(--card, transparent)",
};
const muted: CSSProperties = { color: "var(--muted-foreground, #71717a)", fontSize: 12 };
const stack: CSSProperties = { display: "grid", gap: 12 };

function Pill({ tone, children }: { tone: "ok" | "warn" | "idle"; children: ReactNode }) {
  const colors = {
    ok: { bg: "rgba(34,197,94,0.15)", fg: "#16a34a" },
    warn: { bg: "rgba(245,158,11,0.18)", fg: "#b45309" },
    idle: { bg: "rgba(113,113,122,0.15)", fg: "var(--muted-foreground, #71717a)" },
  }[tone];
  return (
    <span style={{ background: colors.bg, color: colors.fg, borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>
      {children}
    </span>
  );
}

function userName(state: CheckoutState, viewerId: string | null): string {
  if (state.userId && state.userId === viewerId) return "you";
  return state.userLabel ?? (state.userId ? `user ${state.userId.slice(0, 8)}` : "someone");
}

function checkoutHeadline(state: CheckoutState, viewerId: string | null): string {
  const device = state.device ?? "an unnamed device";
  return `Checked out on ${device} by ${userName(state, viewerId)}`;
}

function RemoteState({ loading, error, children }: { loading: boolean; error: { message: string } | null; children: ReactNode }) {
  if (loading) return <div style={muted}>Loading...</div>;
  if (error) return <div style={{ color: "var(--destructive, #dc2626)", fontSize: 13 }}>Muster plugin error: {error.message}</div>;
  return <>{children}</>;
}

function OpenInMuster({ view }: { view: IssueMusterView }) {
  const href = openInMusterHref(view.deepLink, typeof window === "undefined" ? "" : window.location.origin, view.identifier);
  return (
    <a
      href={href}
      data-testid="open-in-muster"
      style={{
        display: "inline-block",
        padding: "6px 14px",
        borderRadius: 6,
        background: "var(--foreground, #18181b)",
        color: "var(--background, #fff)",
        fontSize: 13,
        fontWeight: 600,
        textDecoration: "none",
      }}
    >
      Open in Muster
    </a>
  );
}

export function MusterIssueTab({ context }: PluginDetailTabProps) {
  const { data, loading, error } = usePluginData<IssueMusterView>("issue-muster", {
    companyId: context.companyId,
    issueId: context.entityId,
  });
  return (
    <div style={stack} data-testid="muster-issue-tab" data-viewer-id={context.userId ?? ""}>
      <RemoteState loading={loading} error={error}>
        {data && <IssueCard view={data} viewerId={context.userId} />}
      </RemoteState>
    </div>
  );
}

function IssueCard({ view, viewerId }: { view: IssueMusterView; viewerId: string | null }) {
  const { checkout } = view;
  const idleHours = checkout.lastActivityAt ? (Date.now() - new Date(checkout.lastActivityAt).getTime()) / 3_600_000 : 0;
  const overdue = checkout.status === "checked_out" && idleHours >= view.leaseExpiryHours;
  return (
    <>
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <strong style={{ fontSize: 15 }}>Muster</strong>
              {checkout.status === "checked_out" && <Pill tone={overdue ? "warn" : "ok"}>{overdue ? "Idle" : "Checked out"}</Pill>}
              {checkout.status === "stale" && <Pill tone="warn">No longer held</Pill>}
              {(checkout.status === "released" || checkout.status === "none") && <Pill tone="idle">Not checked out</Pill>}
            </div>
            {checkout.status === "checked_out" && (
              <div data-testid="checkout-headline" style={{ fontSize: 14 }}>
                {checkoutHeadline(checkout, viewerId)}
              </div>
            )}
            {checkout.status === "stale" && (
              <div style={{ fontSize: 13 }}>
                Was checked out on {checkout.device ?? "an unnamed device"} by {userName(checkout, viewerId)}, but the task has since been
                reassigned or closed.
              </div>
            )}
            {checkout.status === "released" && (
              <div style={{ fontSize: 13 }}>
                {checkout.endedBy === "handback" ? "Handed back" : "Released"} {relativeTime(checkout.endedAt)} from{" "}
                {checkout.device ?? "an unnamed device"}.
              </div>
            )}
            {checkout.status === "none" && (
              <div style={{ fontSize: 13 }}>Nobody has checked this task out in Muster. Open it in Muster to work on it locally.</div>
            )}
          </div>
          <OpenInMuster view={view} />
        </div>
        {(checkout.status === "checked_out" || checkout.status === "stale") && (
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: "12px 0 0", fontSize: 13 }}>
            <dt style={muted}>Since</dt>
            <dd style={{ margin: 0 }} title={absoluteTime(checkout.since)}>{relativeTime(checkout.since)}</dd>
            <dt style={muted}>Last activity</dt>
            <dd style={{ margin: 0 }} title={absoluteTime(checkout.lastActivityAt)}>{relativeTime(checkout.lastActivityAt)}</dd>
            {checkout.status === "checked_out" && (
              <>
                <dt style={muted}>Reminder</dt>
                <dd style={{ margin: 0 }}>
                  {checkout.reminderSentAt
                    ? `Sent ${relativeTime(checkout.reminderSentAt)}`
                    : `After ${view.leaseExpiryHours} h without activity`}
                </dd>
              </>
            )}
          </dl>
        )}
      </section>
      <section style={card}>
        <strong style={{ fontSize: 14 }}>Latest local work</strong>
        {view.workLog ? (
          <div style={{ marginTop: 8, fontSize: 13, display: "grid", gap: 4 }} data-testid="worklog-summary">
            <div>{view.workLog.summary ?? "No summary recorded."}</div>
            <div style={muted}>
              {view.workLog.entryCount} work-log {view.workLog.entryCount === 1 ? "entry" : "entries"}
              {view.workLog.updatedAt ? `, updated ${relativeTime(view.workLog.updatedAt)}` : ""}. See the Receipts tab for the full table.
            </div>
          </div>
        ) : (
          <div style={{ ...muted, marginTop: 8 }}>No Local work log document on this task yet.</div>
        )}
      </section>
    </>
  );
}

const th: CSSProperties = { textAlign: "left", padding: "6px 10px", fontSize: 12, color: "var(--muted-foreground, #71717a)", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "8px 10px", fontSize: 13, verticalAlign: "top", borderTop: "1px solid var(--border, #e4e4e7)" };

function costLabel(source: string): string {
  return source === "personal" ? "personal" : source === "org" ? "org" : "unknown";
}

function ReceiptsTable({ workLog }: { workLog: WorkLogView }) {
  const t = workLog.totals;
  return (
    <div style={stack}>
      <div style={{ overflowX: "auto", ...card, padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }} data-testid="receipts-table">
          <thead>
            <tr>
              <th style={th}>When</th>
              <th style={th}>Work</th>
              <th style={th}>Files</th>
              <th style={th}>Tests</th>
              <th style={th}>Tokens</th>
              <th style={th}>Model</th>
              <th style={th}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {workLog.entries.map((entry, index) => (
              <tr key={`${entry.heading}-${index}`}>
                <td style={td} title={absoluteTime(entry.at)}>{entry.at ? relativeTime(entry.at) : "-"}</td>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{entry.title ?? entry.heading}</div>
                  {entry.device && <div style={muted}>{entry.device}</div>}
                  {entry.summary && <div style={{ ...muted, marginTop: 2 }}>{entry.summary}</div>}
                </td>
                <td style={td}>
                  {entry.filesAdded === null && entry.filesRemoved === null && entry.filesChanged === null ? (
                    "-"
                  ) : (
                    <>
                      <span style={{ color: "#16a34a" }}>+{formatCount(entry.filesAdded ?? 0)}</span>{" "}
                      <span style={{ color: "#dc2626" }}>-{formatCount(entry.filesRemoved ?? 0)}</span>
                      {entry.filesChanged !== null && <div style={muted}>{entry.filesChanged} files</div>}
                    </>
                  )}
                </td>
                <td style={td}>
                  {entry.tests ? (
                    <span style={{ color: entry.testsFailed ? "#dc2626" : undefined }}>{entry.tests}</span>
                  ) : (
                    "-"
                  )}
                </td>
                <td style={td}>
                  {formatCount(entry.tokensTotal)}
                  {(entry.tokensIn !== null || entry.tokensOut !== null) && (
                    <div style={muted}>
                      {formatCount(entry.tokensIn)} in / {formatCount(entry.tokensOut)} out
                    </div>
                  )}
                </td>
                <td style={td}>{entry.model ?? "-"}</td>
                <td style={td}>
                  {formatUsd(entry.costUsd)}
                  <div style={muted}>{costLabel(entry.costSource)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={muted} data-testid="receipts-totals">
        {t.entries} {t.entries === 1 ? "entry" : "entries"} | +{formatCount(t.filesAdded)} -{formatCount(t.filesRemoved)} lines |{" "}
        {formatCount(t.tokensTotal)} tokens | personal {formatUsd(t.costPersonalUsd)}, org {formatUsd(t.costOrgUsd)}
        {t.costUnknownUsd > 0 ? `, unlabeled ${formatUsd(t.costUnknownUsd)}` : ""}
      </div>
    </div>
  );
}

/** On a run page the issue id comes from the run record (the viewer's own session reads it). */
function useReceiptsIssueId(entityType: string, entityId: string): { issueId: string | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ issueId: string | null; loading: boolean; error: string | null }>({
    issueId: entityType === "issue" ? entityId : null,
    loading: entityType !== "issue",
    error: null,
  });
  useEffect(() => {
    if (entityType === "issue") {
      setState({ issueId: entityId, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ issueId: null, loading: true, error: null });
    fetch(`/api/heartbeat-runs/${encodeURIComponent(entityId)}`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Run lookup failed (${response.status})`);
        const run = (await response.json()) as { issueId?: string | null; contextSnapshot?: { issueId?: string | null } | null };
        return run.issueId ?? run.contextSnapshot?.issueId ?? null;
      })
      .then((issueId) => !cancelled && setState({ issueId, loading: false, error: null }))
      .catch((err: Error) => !cancelled && setState({ issueId: null, loading: false, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);
  return state;
}

export function MusterReceiptsTab({ context }: PluginDetailTabProps) {
  const target = useReceiptsIssueId(context.entityType, context.entityId);
  return (
    <div style={stack} data-testid="muster-receipts-tab">
      {target.loading && <div style={muted}>Loading...</div>}
      {target.error && <div style={{ color: "var(--destructive, #dc2626)", fontSize: 13 }}>{target.error}</div>}
      {!target.loading && !target.error && !target.issueId && (
        <div style={muted}>This run is not linked to a task, so there is no Local work log to show.</div>
      )}
      {target.issueId && <ReceiptsForIssue companyId={context.companyId} issueId={target.issueId} />}
    </div>
  );
}

function ReceiptsForIssue({ companyId, issueId }: { companyId: string | null; issueId: string }) {
  const { data, loading, error } = usePluginData<{ workLog: WorkLogView | null }>("receipts", { companyId, issueId });
  return (
    <RemoteState loading={loading} error={error}>
      {data?.workLog && data.workLog.entries.length > 0 ? (
        <ReceiptsTable workLog={data.workLog} />
      ) : (
        <div style={card}>
          <strong style={{ fontSize: 14 }}>No receipts yet</strong>
          <div style={{ ...muted, marginTop: 6 }}>
            Muster records files changed, tests, tokens, model and cost in a "Local work log" document while someone works on this task
            locally.
          </div>
        </div>
      )}
    </RemoteState>
  );
}

interface ApiIssue {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority?: string | null;
  projectId?: string | null;
  assigneeUserId?: string | null;
  updatedAt?: string;
}
interface ApiProject {
  id: string;
  name: string;
}

const ACTIVE_STATUSES = "todo,in_progress,in_review,blocked";

/** The viewer's own assigned issues, read with their own session so identity is the host's, not ours. */
function useAssigned(companyId: string | null) {
  const [state, setState] = useState<{ issues: ApiIssue[]; projects: Record<string, string>; loading: boolean; error: string | null }>({
    issues: [],
    projects: {},
    loading: true,
    error: null,
  });
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const [issuesResponse, projectsResponse] = await Promise.all([
          fetch(`/api/companies/${companyId}/issues?assigneeUserId=me&status=${ACTIVE_STATUSES}&limit=100`, { credentials: "include" }),
          fetch(`/api/companies/${companyId}/projects`, { credentials: "include" }),
        ]);
        if (!issuesResponse.ok) throw new Error(`Could not load your tasks (${issuesResponse.status})`);
        const issues = (await issuesResponse.json()) as ApiIssue[] | { issues?: ApiIssue[]; items?: ApiIssue[] };
        const list = Array.isArray(issues) ? issues : (issues.issues ?? issues.items ?? []);
        const projects: Record<string, string> = {};
        if (projectsResponse.ok) {
          for (const project of (await projectsResponse.json()) as ApiProject[]) projects[project.id] = project.name;
        }
        if (!cancelled) setState({ issues: list, projects, loading: false, error: null });
      } catch (err) {
        if (!cancelled) setState({ issues: [], projects: {}, loading: false, error: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);
  return state;
}

function IssueRow({ issue, checkout, viewerId, note }: { issue: ApiIssue; checkout?: CheckoutState; viewerId: string | null; note?: string }) {
  const nav = useHostNavigation();
  const held = checkout?.status === "checked_out";
  return (
    <li style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--border, #e4e4e7)" }}>
      <a {...nav.linkProps(`/issues/${issue.identifier ?? issue.id}`)} style={{ fontSize: 13, fontWeight: 600, minWidth: 64 }}>
        {issue.identifier ?? issue.id.slice(0, 8)}
      </a>
      <span style={{ flex: 1, fontSize: 13 }}>
        {issue.title}
        {note && <div style={muted}>{note}</div>}
      </span>
      <span style={muted}>{issue.status.replace("_", " ")}</span>
      {held && checkout && (
        <span data-testid="checked-out-mark" title={`Last activity ${relativeTime(checkout.lastActivityAt)}`}>
          <Pill tone="ok">Muster: {checkout.device ?? "checked out"}{checkout.userId && checkout.userId !== viewerId ? ` (${checkout.userLabel ?? "other"})` : ""}</Pill>
        </span>
      )}
    </li>
  );
}

export function MusterMyWorkPage({ context }: PluginPageProps) {
  const assigned = useAssigned(context.companyId);
  const issueIds = useMemo(() => assigned.issues.map((issue) => issue.id), [assigned.issues]);
  // The host context's userId is display-only and can be empty; every issue returned for
  // `assigneeUserId=me` carries the viewer's real id, so fall back to that.
  const viewerId = context.userId ?? assigned.issues.find((issue) => issue.assigneeUserId)?.assigneeUserId ?? null;
  const extras = usePluginData<MyWorkExtras>("my-work-extras", {
    companyId: context.companyId,
    userId: viewerId ?? "",
    issueIds,
    ready: !assigned.loading,
  });
  const groups = useMemo(() => {
    const byProject = new Map<string, ApiIssue[]>();
    for (const issue of assigned.issues) {
      const key = issue.projectId ?? "";
      byProject.set(key, [...(byProject.get(key) ?? []), issue]);
    }
    return [...byProject.entries()]
      .map(([projectId, issues]) => ({ projectId, name: projectId ? (assigned.projects[projectId] ?? "Project") : "No project", issues }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [assigned.issues, assigned.projects]);
  const mentions = extras.data?.mentions ?? [];

  return (
    <div style={{ ...stack, maxWidth: 880, padding: 24 }} data-testid="muster-my-work" data-viewer-id={viewerId ?? ""}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>My work</h1>
        <div style={muted}>Tasks assigned to you across projects, plus tasks that mention you. Tasks checked out in Muster are marked.</div>
      </div>
      <RemoteState loading={assigned.loading} error={assigned.error ? { message: assigned.error } : null}>
        {groups.length === 0 && <div style={card}>Nothing is assigned to you right now.</div>}
        {groups.map((group) => (
          <section key={group.projectId || "none"} style={card} data-testid="project-group">
            <strong style={{ fontSize: 14 }}>{group.name}</strong>
            <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
              {group.issues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} checkout={extras.data?.checkouts[issue.id]} viewerId={viewerId} />
              ))}
            </ul>
          </section>
        ))}
        {mentions.length > 0 && (
          <section style={card} data-testid="mentions-group">
            <strong style={{ fontSize: 14 }}>Mentions of you</strong>
            <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
              {mentions.map((mention) => (
                <IssueRow
                  key={mention.issueId}
                  issue={{ id: mention.issueId, identifier: mention.identifier, title: mention.title, status: mention.status }}
                  viewerId={viewerId}
                  note={`${relativeTime(mention.at)}: ${mention.snippet}`}
                />
              ))}
            </ul>
          </section>
        )}
      </RemoteState>
    </div>
  );
}

export function MusterSidebarLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  const { companyId } = useHostContext();
  if (!companyId) return null;
  return (
    <a
      {...nav.linkProps("/my-work")}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", fontSize: 13, fontWeight: 500, color: "inherit", textDecoration: "none" }}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
      </svg>
      <span style={{ flex: 1 }}>My work</span>
    </a>
  );
}
