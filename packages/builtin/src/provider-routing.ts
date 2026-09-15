import { join } from "node:path";
import { existsSync } from "node:fs";

export type ProviderId = "openai-direct" | "hybrow";

export interface ProviderRoute {
  readonly providerId: ProviderId;
  readonly profile: "openai-direct" | "hybrow-gateway";
  /** The exact model ID accepted by the selected provider, never a UI ID. */
  readonly model: string;
  /** Packaged launcher that selects the existing owner-managed Codex profile. */
  readonly command: string;
}

export interface ProviderModelDefinition {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly name: string;
  readonly description: string;
  readonly defaultEffort: string;
  readonly isDefault?: boolean;
}

const DIRECT_MODELS: readonly ProviderModelDefinition[] = [
  { providerId: "openai-direct", model: "gpt-5.6-terra", name: "Terra", description: "OpenAI Direct · signed-in Codex account", defaultEffort: "medium", isDefault: true },
  { providerId: "openai-direct", model: "gpt-5.6-luna", name: "Luna", description: "OpenAI Direct · signed-in Codex account", defaultEffort: "medium" },
  { providerId: "openai-direct", model: "gpt-5.6-sol", name: "Sol", description: "OpenAI Direct · signed-in Codex account", defaultEffort: "medium" },
  { providerId: "openai-direct", model: "gpt-6-astra", name: "Astra", description: "OpenAI Direct · signed-in Codex account", defaultEffort: "high" },
  { providerId: "openai-direct", model: "gpt-5.5", name: "GPT-5.5", description: "OpenAI Direct · signed-in Codex account", defaultEffort: "medium" },
  { providerId: "openai-direct", model: "gpt-5.3-codex-spark", name: "Codex Spark", description: "OpenAI Direct · signed-in Codex account", defaultEffort: "medium" },
];

const HYBROW_MODELS: readonly ProviderModelDefinition[] = [
  { providerId: "hybrow", model: "codex/gpt-5.6-terra", name: "Terra", description: "Hybrow OmniRoute · executor route", defaultEffort: "medium", isDefault: true },
  { providerId: "hybrow", model: "codex/gpt-5.6-luna", name: "Luna", description: "Hybrow OmniRoute · inexpensive executor route", defaultEffort: "medium" },
  { providerId: "hybrow", model: "codex/gpt-5.6-sol", name: "Sol", description: "Hybrow OmniRoute · planning route", defaultEffort: "medium" },
  { providerId: "hybrow", model: "codex/gpt-6-astra", name: "Astra", description: "Hybrow OmniRoute · high-complexity route", defaultEffort: "high" },
  { providerId: "hybrow", model: "claude/claude-fable-5", name: "Claude Fable 5", description: "Hybrow OmniRoute · review model", defaultEffort: "medium" },
];

export const PROVIDER_MODELS: readonly ProviderModelDefinition[] = [...DIRECT_MODELS, ...HYBROW_MODELS];

export function providerModelId(providerId: ProviderId, model: string): string {
  return `${providerId}:${model}`;
}

function launcher(name: "openai-direct" | "hybrow-gateway"): string {
  const bundled = join(__dirname, "resources", `codex-${name}.sh`);
  return existsSync(bundled) ? bundled : join(__dirname, "..", "resources", `codex-${name}.sh`);
}

export function resolveProviderRoute(providerId: ProviderId, model: string): ProviderRoute {
  const definition = PROVIDER_MODELS.find((entry) => entry.providerId === providerId && entry.model === model);
  if (!definition && !(providerId === "openai-direct" && isDirectModel(model))) throw new Error(`Model ${model} is not available through ${providerLabel(providerId)}. Choose a model from that provider; Muster will not fall back to another account.`);
  if (providerId === "openai-direct" && model.includes("/")) throw new Error(`Gateway model ${model} cannot be sent through OpenAI Direct.`);
  return providerId === "openai-direct"
    ? { providerId, profile: "openai-direct", model, command: launcher("openai-direct") }
    : { providerId, profile: "hybrow-gateway", model, command: launcher("hybrow-gateway") };
}

export function routeForModelId(modelId: string): ProviderRoute {
  const separator = modelId.indexOf(":");
  if (separator <= 0) throw new Error(`Model selection ${modelId || "(empty)"} has no provider identity. Select OpenAI Direct or Hybrow OmniRoute before running.`);
  const provider = modelId.slice(0, separator);
  const model = modelId.slice(separator + 1);
  if (provider !== "openai-direct" && provider !== "hybrow") throw new Error(`Unknown provider ${provider}. Select a supported provider before running.`);
  return resolveProviderRoute(provider, model);
}

export function providerLabel(providerId: ProviderId): string {
  return providerId === "openai-direct" ? "OpenAI Direct" : "Hybrow OmniRoute";
}

export interface StoredProviderSelection {
  readonly modelId?: string;
  readonly providerId?: ProviderId;
}

/** Upgrade old unqualified model settings without guessing an unrecognised provider. */
export function migrateProviderSelection<T extends StoredProviderSelection>(settings: T): T & { providerId?: ProviderId; modelId: string } {
  const modelId = settings.modelId ?? "";
  if (!modelId) return { ...settings, modelId };
  try {
    const route = routeForModelId(modelId);
    if (settings.providerId && settings.providerId !== route.providerId) return { ...settings, modelId };
    return { ...settings, modelId: providerModelId(route.providerId, route.model), providerId: route.providerId };
  } catch {
    // Legacy Direct IDs were not provider-qualified. Gateway IDs have always had a prefix.
    if ((!settings.providerId || settings.providerId === "openai-direct") && isDirectModel(modelId)) return { ...settings, modelId: providerModelId("openai-direct", modelId), providerId: "openai-direct" };
    if ((!settings.providerId || settings.providerId === "hybrow") && HYBROW_MODELS.some((entry) => entry.model === modelId)) return { ...settings, modelId: providerModelId("hybrow", modelId), providerId: "hybrow" };
    return { ...settings, modelId };
  }
}

/** Keep native Direct model families, including older saved tasks; never accept gateway namespaces. */
export function isDirectModel(model: string): boolean { return /^(?:gpt-[a-zA-Z0-9.-]+|o[1-9][a-zA-Z0-9.-]*)$/.test(model); }

export function buildProviderDispatch(route: ProviderRoute, conversation: string | undefined): { readonly command: string; readonly model: string; readonly cacheKey?: string } {
  route = resolveProviderRoute(route.providerId, route.model);
  return { command: route.command, model: route.model, ...(conversation ? { cacheKey: `conv:${conversation}:provider:${route.providerId}` } : {}) };
}

export function validateSelection(settings: StoredProviderSelection, threadProvider?: ProviderId): ProviderRoute {
  const migrated = migrateProviderSelection(settings);
  const route = routeForModelId(migrated.modelId);
  if ((settings.providerId && settings.providerId !== route.providerId) || (threadProvider && threadProvider !== route.providerId)) throw new Error("Provider selection conflicts with this task. Start a new task to use another provider.");
  return route;
}

export function assertSelectionChange(current: StoredProviderSelection, next: StoredProviderSelection, busy: boolean, hasThread: boolean): void {
  if (busy) throw new Error("Wait for this task and its agents to finish before changing models or providers.");
  const provider = (selection: StoredProviderSelection) => selection.modelId?.startsWith('claude:') ? 'claude' : selection.providerId ?? (selection.modelId ? validateSelection(selection).providerId : undefined);
  const previous = hasThread ? provider(current) : undefined;
  if (hasThread && previous && previous !== provider(next)) throw new Error("This task belongs to another provider. Start a new task to change providers.");
}

/** The production producer preserves every host option, including MCP and approvals. */
export function applyProviderDispatch<T extends { model?: string; cacheKey?: string; configOverrides?: readonly string[]; env?: Record<string, string>; collaborationMode?: { mode: string; settings: { model: string } } }>(base: T, route: ProviderRoute, conversation?: string) {
  const dispatch = buildProviderDispatch(route, conversation);
  return { ...base, ...dispatch, env: { ...base.env, MUSTER_PROVIDER_NODE: process.execPath, ELECTRON_RUN_AS_NODE: "1" },
    ...(base.collaborationMode ? { collaborationMode: { ...base.collaborationMode, settings: { ...base.collaborationMode.settings, model: route.model } } } : {}) };
}
