import { describe, expect, it } from "vitest";
import { buildMarker } from "../src/lib/markers.js";
import { deriveCheckout, reminderDue, type CheckoutComment } from "../src/lib/checkout.js";

const ME = "user-me";
const issue = { id: "i1", status: "in_progress", assigneeUserId: ME, assigneeAgentId: null };
let seq = 0;
function human(createdAt: string, body: string, userId = ME): CheckoutComment {
  return { id: `c${++seq}`, body, authorUserId: userId, authorAgentId: null, authorType: "user", createdAt };
}
const checkout = (at: string) =>
  human(at, `Checking this out.\n${buildMarker("checkout", { device: "Dhairya's MacBook", "device-id": "mbp-1", by: "Dhairya" })}`);

describe("deriveCheckout", () => {
  it("is none without Muster markers", () => {
    expect(deriveCheckout(issue, [human("2026-10-05T09:00:00Z", "hello")]).status).toBe("none");
  });

  it("derives device, holder and activity from the structured comments", () => {
    const state = deriveCheckout(issue, [
      checkout("2026-10-05T09:00:00Z"),
      human("2026-10-05T10:30:00Z", `Progress.\n${buildMarker("activity")}`),
      human("2026-10-05T11:00:00Z", "Plain note, no marker"),
    ]);
    expect(state).toMatchObject({
      status: "checked_out",
      userId: ME,
      userLabel: "Dhairya",
      device: "Dhairya's MacBook",
      deviceId: "mbp-1",
      since: "2026-10-05T09:00:00.000Z",
      lastActivityAt: "2026-10-05T10:30:00.000Z",
    });
  });

  it("no longer counts a plain 'via Muster' sign-off as activity: only Muster's own marker does", () => {
    const state = deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), human("2026-10-05T12:00:00Z", "Tests green. via Muster · local")]);
    expect(state.lastActivityAt).toBe("2026-10-05T09:00:00.000Z");
  });

  it("applies the desktop's rules: one lease marker per comment, and only the assignee's check-out is a lease", () => {
    const two = human("2026-10-05T10:00:00Z", `${buildMarker("release")}\n${buildMarker("checkout", { device: "x", "device-id": "y", by: "z" })}`);
    expect(deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), two]).status).toBe("checked_out");
    expect(deriveCheckout(issue, [two]).status).toBe("none");
    const other = human("2026-10-05T10:00:00Z", buildMarker("checkout", { device: "evil", "device-id": "e", by: "Eve" }), "user-eve");
    const state = deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), other]);
    expect(state).toMatchObject({ status: "checked_out", device: "Dhairya's MacBook", userId: ME });
    expect(deriveCheckout(issue, [other]).status).toBe("stale");
  });

  it("ends on release and on hand-back", () => {
    const released = deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), human("2026-10-05T10:00:00Z", buildMarker("release"))]);
    expect(released).toMatchObject({ status: "released", endedBy: "release" });
    const handedBack = deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), human("2026-10-05T10:00:00Z", buildMarker("handback"))]);
    expect(handedBack).toMatchObject({ status: "released", endedBy: "handback" });
  });

  it("a later check-out replaces an earlier one", () => {
    const state = deriveCheckout(issue, [
      checkout("2026-10-04T09:00:00Z"),
      human("2026-10-04T10:00:00Z", buildMarker("release")),
      checkout("2026-10-05T09:00:00Z"),
    ]);
    expect(state.status).toBe("checked_out");
    expect(state.since).toBe("2026-10-05T09:00:00.000Z");
  });

  it("is stale once the task is no longer assigned to the holder", () => {
    const comments = [checkout("2026-10-05T09:00:00Z")];
    expect(deriveCheckout({ ...issue, assigneeUserId: "someone-else" }, comments).status).toBe("stale");
    expect(deriveCheckout({ ...issue, assigneeUserId: null, assigneeAgentId: "agent-1" }, comments).status).toBe("stale");
    expect(deriveCheckout({ ...issue, status: "done" }, comments).status).toBe("stale");
  });

  it("ignores markers forged by agents or by a different user's release", () => {
    const forged: CheckoutComment = {
      id: "f1",
      body: buildMarker("checkout", { device: "Evil" }),
      authorUserId: null,
      authorAgentId: "agent-9",
      createdAt: "2026-10-05T09:30:00Z",
    };
    const state = deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), forged, human("2026-10-05T09:40:00Z", buildMarker("release"), "user-other")]);
    expect(state.status).toBe("checked_out");
    expect(state.device).toBe("Dhairya's MacBook");
  });

  it("only another user's activity does not extend the holder's check-out", () => {
    const state = deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), human("2026-10-05T15:00:00Z", buildMarker("activity"), "user-other")]);
    expect(state.lastActivityAt).toBe("2026-10-05T09:00:00.000Z");
  });

  it("reads the plugin's reminder only from agent-authored comments and clears it on new activity", () => {
    const reminder: CheckoutComment = {
      id: "r1",
      body: buildMarker("reminder"),
      authorUserId: null,
      authorAgentId: "plugin-agent",
      createdAt: "2026-10-06T10:00:00Z",
    };
    expect(deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), reminder]).reminderSentAt).toBe("2026-10-06T10:00:00.000Z");
    const humanForged = { ...reminder, id: "r2", authorUserId: ME, authorAgentId: null };
    expect(deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), humanForged]).reminderSentAt).toBeNull();
    const after = deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z"), reminder, human("2026-10-06T11:00:00Z", buildMarker("activity"))]);
    expect(after.reminderSentAt).toBeNull();
  });
});

describe("reminderDue", () => {
  const base = deriveCheckout(issue, [checkout("2026-10-05T09:00:00Z")]);
  it("is due only after the idle limit and only once", () => {
    expect(reminderDue(base, new Date("2026-10-06T08:59:00Z"), 24)).toBe(false);
    expect(reminderDue(base, new Date("2026-10-06T09:00:00Z"), 24)).toBe(true);
    expect(reminderDue({ ...base, reminderSentAt: "2026-10-06T09:05:00.000Z" }, new Date("2026-10-07T09:00:00Z"), 24)).toBe(false);
  });
  it("is never due for released or stale check-outs", () => {
    expect(reminderDue({ ...base, status: "stale" }, new Date("2026-10-09T09:00:00Z"), 24)).toBe(false);
    expect(reminderDue({ ...base, status: "released" }, new Date("2026-10-09T09:00:00Z"), 24)).toBe(false);
  });
});
