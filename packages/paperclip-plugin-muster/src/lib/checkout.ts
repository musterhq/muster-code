import { parseMarkers } from "./markers.js";

/** The slice of an issue the derivation needs. */
export interface CheckoutIssue {
  id: string;
  status?: string | null;
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
}

/** The slice of an issue comment the derivation needs. */
export interface CheckoutComment {
  id: string;
  body: string;
  authorUserId?: string | null;
  authorAgentId?: string | null;
  derivedAuthorAgentId?: string | null;
  authorType?: string | null;
  createdAt: string | Date;
}

export type CheckoutStatus =
  /** Assigned to the human who posted the latest `muster:checkout`, and not released since. */
  | "checked_out"
  /** A check-out exists but the task has since been reassigned or closed, so it no longer holds. */
  | "stale"
  /** The user released it or handed it back. */
  | "released"
  /** Muster never touched this issue. */
  | "none";

export interface CheckoutState {
  status: CheckoutStatus;
  userId: string | null;
  /** Display name from the marker's `by` attribute, when Muster supplied one. */
  userLabel: string | null;
  device: string | null;
  deviceId: string | null;
  /** ISO time of the check-out comment (server clock). */
  since: string | null;
  /** ISO time of the latest Muster comment from the checking-out user. */
  lastActivityAt: string | null;
  lastActivityCommentId: string | null;
  /** ISO time of the latest reminder the plugin posted for the current idle stretch, if any. */
  reminderSentAt: string | null;
  /** ISO time the check-out ended (release or hand-back), for released/none states. */
  endedAt: string | null;
  endedBy: "release" | "handback" | null;
}

const CLOSED_STATUSES = new Set(["done", "cancelled"]);

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function emptyState(): CheckoutState {
  return {
    status: "none",
    userId: null,
    userLabel: null,
    device: null,
    deviceId: null,
    since: null,
    lastActivityAt: null,
    lastActivityCommentId: null,
    reminderSentAt: null,
    endedAt: null,
    endedBy: null,
  };
}

/**
 * Derive the Muster check-out state of an issue from its human assignee plus the structured
 * comments Muster posts. There is no server-side lease: the issue's human assignee is the lock,
 * and the comment trail says which device holds it and how recently it was touched.
 *
 * Trust rules: only comments authored by a human user count for checkout, activity, release and
 * hand-back. A comment written by an agent (or by the plugin) can never start or extend a
 * check-out. Reminder markers are read only from agent-authored comments (the plugin's own).
 */
export function deriveCheckout(issue: CheckoutIssue, comments: CheckoutComment[]): CheckoutState {
  const ordered = [...comments].sort((a, b) => toIso(a.createdAt).localeCompare(toIso(b.createdAt)));
  let state = emptyState();
  let lastReminderAt: string | null = null;
  let active = false;

  for (const comment of ordered) {
    const createdAt = toIso(comment.createdAt);
    const markers = parseMarkers(comment.body);
    const byHuman =
      Boolean(comment.authorUserId) &&
      !comment.authorAgentId &&
      !comment.derivedAuthorAgentId &&
      (!comment.authorType || comment.authorType === "user");

    if (!byHuman) {
      if (markers.some((marker) => marker.kind === "reminder")) lastReminderAt = createdAt;
      continue;
    }

    // One lease marker per comment (the desktop applies the same rule): a body with two cannot be trusted to mean either, so none of them count as a lease event.
    const leaseMarkers = markers.filter((marker) => marker.kind === "checkout" || marker.kind === "release" || marker.kind === "handback");
    const single = leaseMarkers.length === 1 ? leaseMarkers[0] : undefined;
    // Only the person the task is assigned to can take over a held task: a check-out by anyone else never replaces a live lease (and shows as "no longer held" on its own).
    const checkout = single?.kind === "checkout" && (comment.authorUserId === issue.assigneeUserId || !active) ? single : undefined;
    const ending = single && single.kind !== "checkout" ? single : undefined;

    if (checkout) {
      state = {
        status: "checked_out",
        userId: comment.authorUserId ?? null,
        userLabel: checkout.attrs.by ?? null,
        device: checkout.attrs.device ?? null,
        deviceId: checkout.attrs["device-id"] ?? null,
        since: createdAt,
        lastActivityAt: createdAt,
        lastActivityCommentId: comment.id,
        reminderSentAt: null,
        endedAt: null,
        endedBy: null,
      };
      active = true;
      lastReminderAt = null;
      continue;
    }

    if (ending) {
      if (active && comment.authorUserId === state.userId) {
        state = {
          ...state,
          status: "released",
          endedAt: createdAt,
          endedBy: ending.kind === "handback" ? "handback" : "release",
        };
        active = false;
      }
      continue;
    }

    // Activity is a marker Muster wrote; a plain "via Muster" sign-off typed by anyone no longer keeps a lease alive.
    const isActivity = leaseMarkers.length === 0 && markers.some((marker) => marker.kind === "activity");
    if (isActivity && active && comment.authorUserId === state.userId) {
      state = { ...state, lastActivityAt: createdAt, lastActivityCommentId: comment.id };
    }
  }

  if (active) {
    const holds =
      !CLOSED_STATUSES.has(issue.status ?? "") &&
      !issue.assigneeAgentId &&
      Boolean(issue.assigneeUserId) &&
      issue.assigneeUserId === state.userId;
    if (!holds) state = { ...state, status: "stale" };
    if (lastReminderAt && state.lastActivityAt && lastReminderAt > state.lastActivityAt) {
      state = { ...state, reminderSentAt: lastReminderAt };
    }
  }
  return state;
}

export function idleMs(state: CheckoutState, now: Date): number | null {
  if (!state.lastActivityAt) return null;
  return Math.max(0, now.getTime() - new Date(state.lastActivityAt).getTime());
}

/** True when a held check-out has been idle for at least `hours` and no reminder went out since. */
export function reminderDue(state: CheckoutState, now: Date, hours: number): boolean {
  if (state.status !== "checked_out" || state.reminderSentAt) return false;
  const idle = idleMs(state, now);
  return idle !== null && idle >= hours * 3_600_000;
}
