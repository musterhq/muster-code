import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { JOB_KEYS } from "./manifest.js";
import { loadIssueMuster, loadMyWorkExtras, loadWorkLog, runLeaseExpiry } from "./lib/service.js";

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
  return value;
}

const plugin = definePlugin({
  async setup(ctx) {
    // `companyId` is injected by the host after it verifies the viewer can access that company.
    ctx.data.register("issue-muster", async (params) =>
      loadIssueMuster(ctx, requireString(params, "companyId"), requireString(params, "issueId")),
    );

    ctx.data.register("receipts", async (params) => {
      const workLog = await loadWorkLog(ctx, requireString(params, "companyId"), requireString(params, "issueId"));
      return { workLog };
    });

    ctx.data.register("my-work-extras", async (params) => {
      // The page asks before it knows who is viewing; answer with nothing rather than an error.
      if (typeof params.userId !== "string" || params.userId === "" || params.ready === false) {
        return { checkouts: {}, mentions: [] };
      }
      const issueIds = Array.isArray(params.issueIds) ? params.issueIds.filter((id): id is string => typeof id === "string") : [];
      return loadMyWorkExtras(ctx, requireString(params, "companyId"), requireString(params, "userId"), issueIds);
    });

    ctx.jobs.register(JOB_KEYS.leaseExpiry, async () => {
      await runLeaseExpiry(ctx);
    });
  },

  async onHealth() {
    return { status: "ok", message: "Muster plugin worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
