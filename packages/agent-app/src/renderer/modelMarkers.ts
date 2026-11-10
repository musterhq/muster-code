import type {ProviderInfo, ReasoningEffort} from '../shared/protocol';
import type {TranscriptEntry} from './components/activityGrouping';
import {EFFORT_LABELS} from './components/composerMenus';

/** #401: what a turn ran with, recorded on its user message by the runtime (`data.ranWith`). */
export interface RanWith {providerId: string; model: string; effort?: string}

const ranWithOf = (row: TranscriptEntry): RanWith | undefined => {
  if (row.kind !== 'user') return undefined;
  const ran = row.data?.ranWith as Partial<RanWith> | undefined;
  return ran && typeof ran.model === 'string' && ran.model && typeof ran.providerId === 'string' ? {providerId: ran.providerId, model: ran.model, ...(typeof ran.effort === 'string' ? {effort: ran.effort} : {})} : undefined;
};

/** Row index -> what the turn switched to, for each user message whose turn ran another model, provider or effort than the
 *  previous recorded turn. The first recorded turn and messages without a record get none. */
export function modelChangeRows(rows: readonly TranscriptEntry[]): Map<number, RanWith> {
  const out = new Map<number, RanWith>();
  let previous: RanWith | undefined;
  for (let index = 0; index < rows.length; index++) {
    const ran = ranWithOf(rows[index]!);
    if (!ran) continue;
    if (previous && (previous.model !== ran.model || previous.providerId !== ran.providerId || (previous.effort ?? '') !== (ran.effort ?? ''))) out.set(index, ran);
    previous = ran;
  }
  return out;
}

/** "Switched to GPT-5.5 · high effort"; the model's id when no listed provider names it. */
export function modelChangeLabel(ran: RanWith, providers: readonly Pick<ProviderInfo, 'id' | 'models'>[] = []): string {
  const listed = providers.find(provider => provider.id === ran.providerId)?.models.find(model => model.id === ran.model)
    ?? providers.flatMap(provider => provider.models).find(model => model.id === ran.model);
  const effort = ran.effort && ran.effort in EFFORT_LABELS ? EFFORT_LABELS[ran.effort as ReasoningEffort].toLowerCase() : undefined;
  return `Switched to ${listed?.name ?? ran.model}${effort ? ` · ${effort} effort` : ''}`;
}
