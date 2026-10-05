import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueComment } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { buildMarker } from "../src/lib/markers.js";
import { runLeaseExpiry } from "../src/lib/service.js";

const COMPANY = "co-1";
const ME = "user-me";

function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: COMPANY,
    identifier: `MUS-${id}`,
    title: `Task ${id}`,
    status: "in_progress",
    priority: "medium",
    projectId: "proj-1",
    assigneeUserId: ME,
    assigneeAgentId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-05T00:00:00Z"),
    ...over,
  } as unknown as Issue;
}

function comment(id: string, issueId: string, createdAt: string, body: string, over: Partial<IssueComment> = {}): IssueComment {
  return {
    id,
    companyId: COMPANY,
    issueId,
    authorType: "user",
    authorUserId: ME,
    authorAgentId: null,
    body,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    ...over,
  } as unknown as IssueComment;
}

const checkout = (at: string, issueId: string, id = `co-${issueId}`) =>
  comment(id, issueId, at, `On it.\n${buildMarker("checkout", { device: "Dhairya's MacBook", by: "Dhairya" })}`);

async function boot(config: Record<string, unknown> = {}) {
  // The write capability is granted to the harness only so tests can seed documents; the worker never writes.
  const harness = createTestHarness({ manifest, config, capabilities: [...manifest.capabilities, "issue.documents.write"] });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("manifest", () => {
  it("declares only the least capabilities and nothing that mutates, spends or calls out", () => {
    for (const forbidden of [
      "http.outbound",
      "secrets.read-ref",
      "plugin.state.write",
      "api.routes.register",
      "webhooks.receive",
      "issues.update",
      "issues.create",
      "issues.checkout",
      "issues.wakeup",
      "issue.documents.write",
      "agents.invoke",
      "issue.comments.create_human_attributed",
    ]) {
      expect(manifest.capabilities).not.toContain(forbidden);
    }
    expect(manifest.capabilities).toContain("jobs.schedule");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.jobs?.[0]?.schedule).toBe("0 * * * *");
  });

  it("declares a slot for every export the UI bundle needs", () => {
    const slots = manifest.ui?.slots ?? [];
    expect(slots.map((s) => s.exportName).sort()).toEqual(["MusterIssueTab", "MusterMyWorkPage", "MusterReceiptsTab", "MusterSidebarLink"]);
    expect(slots.find((s) => s.id === "muster-receipts-tab")?.entityTypes).toEqual(["issue", "run"]);
    expect(slots.find((s) => s.type === "page")?.routePath).toBe("my-work");
  });
});

describe("issue-muster data", () => {
  it("returns the check-out derived from assignee plus comments, the deep link and the work-log summary", async () => {
    const harness = await boot();
    harness.seed({
      issues: [issue("1")],
      issueComments: [checkout("2026-10-05T09:00:00Z", "1"), comment("a1", "1", "2026-10-05T10:00:00Z", `Done step. ${buildMarker("activity")}`)],
    });
    await harness.ctx.issues.documents.upsert({
      issueId: "1",
      companyId: COMPANY,
      key: "local-work-log",
      title: "Local work log",
      body: "## 2026-10-05T09:30:00Z · Add retry\n- Files: +10 -2 (3 files)\n- Summary: Added retry.\n",
    });
    const view = await harness.getData<any>("issue-muster", { companyId: COMPANY, issueId: "1" });
    expect(view.checkout).toMatchObject({ status: "checked_out", device: "Dhairya's MacBook", userId: ME, lastActivityAt: "2026-10-05T10:00:00.000Z" });
    expect(view.deepLink).toBe("muster://task/co-1/1");
    expect(view.workLog).toMatchObject({ summary: "Added retry.", entryCount: 1 });
    expect(view.leaseExpiryHours).toBe(24);
  });

  it("reports not checked out when there is no marker and no work log", async () => {
    const harness = await boot({ leaseExpiryHours: 6 });
    harness.seed({ issues: [issue("2")] });
    const view = await harness.getData<any>("issue-muster", { companyId: COMPANY, issueId: "2" });
    expect(view.checkout.status).toBe("none");
    expect(view.workLog).toBeNull();
    expect(view.leaseExpiryHours).toBe(6);
  });

  it("rejects calls without an issue id", async () => {
    const harness = await boot();
    await expect(harness.getData("issue-muster", { companyId: COMPANY })).rejects.toThrow(/issueId/);
  });
});

describe("receipts data", () => {
  it("parses the Local work log document into rows and totals", async () => {
    const harness = await boot();
    harness.seed({ issues: [issue("1")] });
    await harness.ctx.issues.documents.upsert({
      issueId: "1",
      companyId: COMPANY,
      key: "work-log-2",
      title: "Local work log",
      body: "## 2026-10-05T09:14:00Z · A\n- Tokens: 100 in / 50 out\n- Cost: $0.10 (personal)\n## 2026-10-05T10:14:00Z · B\n- Cost: $0.20 (org)\n",
    });
    const { workLog } = await harness.getData<any>("receipts", { companyId: COMPANY, issueId: "1" });
    expect(workLog.entries).toHaveLength(2);
    expect(workLog.totals).toMatchObject({ tokensTotal: 150, costPersonalUsd: 0.1, costOrgUsd: 0.2 });
  });

  it("returns null when the task has no work log", async () => {
    const harness = await boot();
    harness.seed({ issues: [issue("1")] });
    expect((await harness.getData<any>("receipts", { companyId: COMPANY, issueId: "1" })).workLog).toBeNull();
  });
});

describe("my-work-extras data", () => {
  it("marks checked-out items and finds mentions of the viewer on other tasks", async () => {
    const harness = await boot();
    harness.seed({
      issues: [issue("1"), issue("2"), issue("3", { assigneeUserId: "someone", status: "todo", title: "Review me" })],
      issueComments: [
        checkout("2026-10-05T09:00:00Z", "1"),
        comment("m1", "3", "2026-10-05T12:00:00Z", `Could you look? [@Dhairya](user://${ME}) <!-- hidden -->`, { authorUserId: "someone" }),
        comment("m2", "2", "2026-10-05T12:00:00Z", `[@Other](user://other) ping`, { authorUserId: "someone" }),
      ],
    });
    const extras = await harness.getData<any>("my-work-extras", { companyId: COMPANY, userId: ME, issueIds: ["1", "2"] });
    expect(extras.checkouts["1"].status).toBe("checked_out");
    expect(extras.checkouts["2"].status).toBe("none");
    expect(extras.mentions).toHaveLength(1);
    expect(extras.mentions[0]).toMatchObject({ issueId: "3", title: "Review me", snippet: "Could you look? @Dhairya" });
  });
});

describe("my-work-extras guard", () => {
  it("answers an empty result before the viewer is known instead of failing", async () => {
    const harness = await boot();
    harness.seed({ issues: [issue("1")] });
    expect(await harness.getData("my-work-extras", { companyId: COMPANY, userId: "", issueIds: ["1"] })).toEqual({ checkouts: {}, mentions: [] });
    expect(await harness.getData("my-work-extras", { companyId: COMPANY, userId: ME, ready: false, issueIds: ["1"] })).toEqual({ checkouts: {}, mentions: [] });
  });
});

describe("lease-expiry job", () => {
  const NOW = new Date("2026-10-06T10:00:00Z");
  afterEach(() => vi.useRealTimers());

  async function seeded(extra: { issues?: Issue[]; comments?: IssueComment[] } = {}, config: Record<string, unknown> = {}) {
    const harness = await boot(config);
    harness.seed({
      companies: [{ id: COMPANY, name: "Muster Co" } as any],
      issues: [issue("1"), ...(extra.issues ?? [])],
      issueComments: [checkout("2026-10-05T09:00:00Z", "1"), ...(extra.comments ?? [])],
    });
    return harness;
  }
  const posted = (harness: Awaited<ReturnType<typeof boot>>, issueId: string) =>
    harness.ctx.issues.listComments(issueId, COMPANY).then((list) => list.filter((c) => c.body.includes("muster:reminder")));

  it("posts one reminder that mentions the assignee, then stays quiet", async () => {
    const harness = await seeded();
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const first = await runLeaseExpiry(harness.ctx, NOW);
    expect(first.reminded).toEqual([{ companyId: COMPANY, issueId: "1" }]);
    const reminders = await posted(harness, "1");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.body).toContain(`](user://${ME})`);
    expect(reminders[0]!.body).toContain("Dhairya's MacBook");
    expect(reminders[0]!.body).toContain("does not reassign");

    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    const second = await runLeaseExpiry(harness.ctx, new Date("2026-10-07T10:00:00Z"));
    expect(second.reminded).toEqual([]);
    expect(await posted(harness, "1")).toHaveLength(1);
  });

  it("does not remind before the limit and honours a configured limit", async () => {
    const early = await seeded();
    expect((await runLeaseExpiry(early.ctx, new Date("2026-10-06T08:00:00Z"))).reminded).toEqual([]);
    const tight = await seeded({}, { leaseExpiryHours: 2 });
    expect((await runLeaseExpiry(tight.ctx, new Date("2026-10-05T12:00:00Z"))).reminded).toHaveLength(1);
  });

  it("skips released tasks and never touches assignee or status", async () => {
    const harness = await seeded({
      issues: [issue("2")],
      comments: [checkout("2026-10-05T08:00:00Z", "2"), comment("rel", "2", "2026-10-05T09:00:00Z", buildMarker("release"))],
    });
    await runLeaseExpiry(harness.ctx, NOW);
    expect(await posted(harness, "2")).toHaveLength(0);
    const before = await harness.ctx.issues.get("1", COMPANY);
    expect(before?.assigneeUserId).toBe(ME);
    expect(before?.status).toBe("in_progress");
  });

  it("ignores agent-assigned and unassigned tasks even with a forged marker", async () => {
    const harness = await seeded({
      issues: [issue("3", { assigneeUserId: null, assigneeAgentId: "agent-1" }), issue("4", { assigneeUserId: null })],
      comments: [checkout("2026-10-05T08:00:00Z", "3"), checkout("2026-10-05T08:00:00Z", "4")],
    });
    const result = await runLeaseExpiry(harness.ctx, NOW);
    expect(result.reminded.map((r) => r.issueId)).toEqual(["1"]);
  });

  it("skips a company the host will not scope the job to and carries on with the others", async () => {
    const harness = await seeded();
    const realGet = harness.ctx.config.get.bind(harness.ctx.config);
    harness.ctx.config.get = async (companyId?: string) => {
      if (companyId === "co-denied") throw new Error("company context is required");
      return realGet(companyId);
    };
    harness.seed({ companies: [{ id: "co-denied", name: "Denied" } as any, { id: COMPANY, name: "Muster Co" } as any] });
    const result = await runLeaseExpiry(harness.ctx, NOW);
    expect(result.skipped).toEqual([{ companyId: "co-denied", reason: "company context is required" }]);
    expect(result.reminded.map((r) => r.issueId)).toEqual(["1"]);
  });

  it("is wired to the hourly job key", async () => {
    const harness = await seeded();
    await harness.runJob("lease-expiry");
    expect(harness.logs.some((entry) => entry.message.includes("lease-expiry pass finished"))).toBe(true);
  });
});
