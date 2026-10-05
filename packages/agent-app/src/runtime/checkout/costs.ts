/**
 * Cost entries for local work (#117). Local turns run on the person's own providers, so the cost is theirs, not the org's. The server's cost
 * events have a free-text `biller` and a `billingType`, and no user column, so Muster says who paid in the biller:
 *   biller "personal:<userId>"  the person's own subscription or API key (the org's budget must not count it)
 *   biller "org"                a route the org provides and pays for
 * and billingType is `subscription_included` (a signed-in subscription: no per-token charge, cost 0) or `metered_api` (a key, priced by tokens).
 * The Ledger separates the two by `biller`. The billing code names which engine ran the turn: `muster-local/org-definition/<run>` (the org's own agent
 * definitions on the person's providers) or `muster-local/personal-subscription/<run>` (the person's own model choice).
 */
import type { TurnReceipt } from './reports.ts';
export type Payer = 'personal' | 'org';
export interface ProviderPayInfo { id: string; name?: string; driver?: string; subscription?: boolean; /** The org provides and pays for this route (an org gateway). */ orgManaged?: boolean }
export const BILLER_ORG = 'org';
export const billerFor = (payer: Payer, userId: string): string => payer === 'org' ? BILLER_ORG : `personal:${userId}`;
export const isPersonalBiller = (biller: string): boolean => biller.startsWith('personal:');
export function payerOf(provider: ProviderPayInfo | undefined): Payer { return provider?.orgManaged ? 'org' : 'personal'; }
/** A subscription is a signed-in CLI or ChatGPT login; a key is metered. Unknown providers are metered (never presented as free). */
export function billingTypeOf(provider: ProviderPayInfo | undefined): 'subscription_included' | 'metered_api' {
  if (provider?.subscription) return 'subscription_included';
  return /claude[-_ ]?code|chatgpt|codex[-_ ]?sub/i.test(`${provider?.id ?? ''} ${provider?.driver ?? ''}`) ? 'subscription_included' : 'metered_api';
}
export interface CostEventBody {
  agentId: string; issueId: string; projectId: string | null; provider: string; biller: string; billingType: 'subscription_included' | 'metered_api'; model: string;
  inputTokens: number; cachedInputTokens: number; outputTokens: number; costCents: number; occurredAt: string; billingCode: string;
}
/** The POST /companies/:id/cost-events body for one local turn. `agentId` is required by the server: the org agent the work stands in for. */
export function costEventFor(input: { engine: 'org-definition' | 'personal-subscription'; receipt: TurnReceipt; costUsd: number | null; agentId: string; issueId: string; projectId: string | null; userId: string; provider: ProviderPayInfo | undefined }): CostEventBody {
  const { receipt, provider } = input, payer = payerOf(provider), billingType = billingTypeOf(provider);
  return {
    agentId: input.agentId, issueId: input.issueId, projectId: input.projectId, provider: provider?.name ?? receipt.provider ?? 'local', biller: billerFor(payer, input.userId), billingType, model: receipt.model ?? 'unknown',
    inputTokens: receipt.tokens?.input ?? 0, cachedInputTokens: receipt.tokens?.cached ?? 0, outputTokens: receipt.tokens?.output ?? 0,
    costCents: billingType === 'subscription_included' || input.costUsd === null ? 0 : Math.max(0, Math.round(input.costUsd * 100)), occurredAt: receipt.at, billingCode: `muster-local/${input.engine}/${receipt.runId}`,
  };
}
