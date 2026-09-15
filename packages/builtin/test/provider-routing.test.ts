import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProviderDispatch, assertSelectionChange, buildProviderDispatch, migrateProviderSelection, providerModelId, resolveProviderRoute, routeForModelId, validateSelection } from "../src/provider-routing.js";

test("provider routes keep direct and Hybrow model identities distinct", () => {
  const direct = routeForModelId(providerModelId("openai-direct", "gpt-5.6-luna"));
  const hybrow = routeForModelId(providerModelId("hybrow", "codex/gpt-5.6-luna"));
  assert.deepEqual({ provider: direct.providerId, profile: direct.profile, model: direct.model }, { provider: "openai-direct", profile: "openai-direct", model: "gpt-5.6-luna" });
  assert.deepEqual({ provider: hybrow.providerId, profile: hybrow.profile, model: hybrow.model }, { provider: "hybrow", profile: "hybrow-gateway", model: "codex/gpt-5.6-luna" });
  assert.notEqual(direct.command, hybrow.command);
});

test("legacy selections migrate only when their provider can be proven", () => {
  for (const id of ["gpt-5.5", "gpt-5.3-codex-spark"]) assert.equal(validateSelection(migrateProviderSelection({ modelId: id })).model, id);
  assert.deepEqual(migrateProviderSelection({ modelId: "gpt-5.6-terra" }), { modelId: "openai-direct:gpt-5.6-terra", providerId: "openai-direct" });
  assert.deepEqual(migrateProviderSelection({ modelId: "codex/gpt-5.6-luna" }), { modelId: "hybrow:codex/gpt-5.6-luna", providerId: "hybrow" });
  assert.deepEqual(migrateProviderSelection({ modelId: "unknown-model" }), { modelId: "unknown-model" });
});

test("invalid provider/model combinations fail instead of falling back", () => {
  assert.throws(() => resolveProviderRoute("openai-direct", "codex/gpt-5.6-luna"), /not available|cannot be sent/i);
  assert.throws(() => routeForModelId("openai-direct:claude/claude-fable-5"), /not available|cannot be sent/i);
  assert.throws(() => routeForModelId("gpt-5.6-terra"), /no provider identity/i);
  assert.throws(() => routeForModelId("other:gpt-5.6-terra"), /unknown provider/i);
});

test("provider dispatch uses a provider-scoped warm key without changing browser overrides or approvals", () => {
  const route = routeForModelId("hybrow:codex/gpt-5.6-luna");
  const existingOverrides = ["mcp_servers.muster_browser.command=\"/tmp/browser-mcp\"", "mcp_servers.muster_browser.args=[]"];
  const approval = async () => ({ decision: "accept" });
  const runInput = applyProviderDispatch({ configOverrides: existingOverrides, onRequest: approval, collaborationMode: { mode: "plan", settings: { model: "hybrow:codex/gpt-5.6-luna" } } }, route, "pane-1");
  assert.equal(runInput.model, "codex/gpt-5.6-luna");
  assert.match(runInput.cacheKey!, /provider:hybrow$/);
  assert.deepEqual(runInput.configOverrides, existingOverrides);
  assert.equal(typeof runInput.onRequest, "function");
  assert.equal(runInput.onRequest, approval);
  assert.equal(runInput.collaborationMode.settings.model, "codex/gpt-5.6-luna");
});

test("explicit conflicting persistence remains invalid across reload", () => {
  for (const selection of [{ providerId: "hybrow" as const, modelId: "gpt-5.6-terra" }, { providerId: "hybrow" as const, modelId: "openai-direct:gpt-5.6-terra" }]) {
    const restored = migrateProviderSelection(JSON.parse(JSON.stringify(selection)));
    assert.deepEqual(restored, selection);
    assert.throws(() => validateSelection(restored), /identity|conflicts/);
  }
});

test("busy work and existing thread ownership block provider switches", () => {
  const direct = { modelId: "openai-direct:gpt-5.6-terra" };
  const gateway = { modelId: "hybrow:codex/gpt-5.6-luna" };
  assert.throws(() => assertSelectionChange(direct, gateway, true, false), /finish/);
  assert.throws(() => assertSelectionChange(direct, gateway, false, true), /another provider/);
  assert.doesNotThrow(() => assertSelectionChange(direct, gateway, false, false));
  assert.throws(() => validateSelection(gateway, "openai-direct"), /conflicts/);
  assert.equal(validateSelection(migrateProviderSelection({ modelId: "codex/gpt-5.6-luna" }), "hybrow").profile, "hybrow-gateway");
});
