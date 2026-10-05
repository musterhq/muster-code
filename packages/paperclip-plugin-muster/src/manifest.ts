import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "musterhq.muster";
export const PAGE_ROUTE = "my-work";
export const JOB_KEYS = { leaseExpiry: "lease-expiry" } as const;

/**
 * Capabilities are the least set the features need, and every one is read-only except
 * `issue.comments.create` (the idle reminder). There is no http.outbound, no secrets, no
 * plugin.state, no api.routes and no issue update/assign/wakeup capability.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Muster",
  description:
    "Companion for Muster Agent's local check-out workflow: see who has a task checked out and on which device, open it in Muster, review local work-log receipts, and get a reminder when a check-out goes idle.",
  author: "Muster",
  categories: ["ui", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issue.comments.read",
    "issue.comments.create",
    "issue.documents.read",
    "jobs.schedule",
    "ui.detailTab.register",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      leaseExpiryHours: {
        type: "number",
        title: "Idle check-out reminder (hours)",
        description:
          "Post one reminder comment when a task checked out through Muster has had no Muster activity for this many hours. The task is never reassigned.",
        default: 24,
        minimum: 1,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.leaseExpiry,
      displayName: "Idle Muster check-out reminder",
      description: "Hourly: remind the assignee about Muster check-outs with no recent activity.",
      schedule: "0 * * * *",
    },
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "muster-issue-tab",
        displayName: "Muster",
        exportName: "MusterIssueTab",
        entityTypes: ["issue"],
      },
      {
        type: "detailTab",
        id: "muster-receipts-tab",
        displayName: "Receipts",
        exportName: "MusterReceiptsTab",
        entityTypes: ["issue", "run"],
      },
      {
        type: "page",
        id: "muster-my-work",
        displayName: "My work",
        exportName: "MusterMyWorkPage",
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: "muster-my-work-link",
        displayName: "My work",
        exportName: "MusterSidebarLink",
      },
    ],
  },
};

export default manifest;
