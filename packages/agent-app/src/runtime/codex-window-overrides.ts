import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {compactionThreshold, effectiveContextWindow, type ModelWindowInfo} from '../shared/context-window.ts';

const KEYS = ['model_context_window', 'model_auto_compact_token_limit'] as const;
/** Compaction keys the user set themselves at the top of `<CODEX_HOME>/config.toml` (before any table). Only these key names are read. */
export function userCompactionKeys(codexHome: string | undefined): Set<string> {
  const found = new Set<string>();
  if (!codexHome) return found;
  let text = '';
  try { text = readFileSync(join(codexHome, 'config.toml'), 'utf8'); } catch { return found; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const key = /^([A-Za-z0-9_]+)\s*=/.exec(trimmed)?.[1];
    if (key && (KEYS as readonly string[]).includes(key)) found.add(key);
  }
  return found;
}

/** #426: `-c` overrides that give Codex the model's own window and compaction point when Muster knows them (catalog JSON or the
 *  router's listing) — so a gateway model Codex has no metadata for still auto-compacts before it is full. A key the user set in
 *  config.toml is never overridden. #739: `engineWindow` is the window Codex reported for this model on this chat. When it is below
 *  what Codex reports for an adopted window (95% of it), Codex did not take ours, so it compacts at 85% of its own, the same point
 *  the meter shows. */
export function codexWindowOverrides(model: ModelWindowInfo | undefined, userKeys: Set<string>, engineWindow?: number | null): string[] {
  if (!model?.contextWindow || model.contextWindow <= 0) return [];
  const declared = effectiveContextWindow(model, null);
  // The same window the meter and Muster's trigger use, so all three agree on where compaction starts.
  const threshold = compactionThreshold(effectiveContextWindow(model, engineWindow), model.autoCompactTokenLimit);
  // The window override stays the declared one: Codex clamps it anyway, and a changing value would restart its session each turn.
  return [
    ...(userKeys.has('model_context_window') ? [] : [`model_context_window=${declared.tokens}`]),
    ...(userKeys.has('model_auto_compact_token_limit') ? [] : [`model_auto_compact_token_limit=${threshold.tokens}`]),
  ];
}
