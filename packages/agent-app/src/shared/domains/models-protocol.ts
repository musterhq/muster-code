/** Models domain contract. Add commands here; the allowlist and service dispatch pick them up. */
import type { ModelPolicy, PricingInput, UsageReport } from '../model-catalog.ts';

export interface ModelsCommands {
  /** The user's visibility policy and price overrides (PRO-04). */
  'models.policy.get': { input: Record<string, never>; output: ModelPolicy };
  /** Hide or show one model (key = modelKey(providerId, model)) in the model picker. Hidden models stay runnable. */
  'models.policy.setHidden': { input: { key: string; hidden: boolean }; output: ModelPolicy };
  /** Set (or clear with null) the user's price for a model, in dollars per million tokens. Overrides a catalog price. */
  'models.policy.setPricing': { input: { key: string; pricing: PricingInput | null }; output: ModelPolicy };
  /** Clears every hidden model and price override. */
  'models.policy.reset': { input: Record<string, never>; output: ModelPolicy };
  /** Tokens this chat's runs reported, per provider/model, with estimated cost where a price is known (PRO-06). */
  'models.usage.chat': { input: { chatId: string }; output: UsageReport };
  /** The same for every chat in a Project, with per-task cost for Project task runs (PRJ-14). */
  'models.usage.project': { input: { projectId: string }; output: UsageReport };
}
export type ModelsEvent =
  | { type: 'modelPolicyChanged'; policy: ModelPolicy }
  | { type: 'modelUsageChanged'; chatId: string; projectId?: string };
export const MODELS_COMMANDS = {
  'models.policy.get': true, 'models.policy.setHidden': true, 'models.policy.setPricing': true, 'models.policy.reset': true,
  'models.usage.chat': true, 'models.usage.project': true,
} as const satisfies Record<keyof ModelsCommands, true>;
