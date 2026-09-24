/**
 * Models offered through Claude Code. Claude Code has no model-list command, so the list is built from:
 *   1. a versioned catalog shipped with Muster (catalogs/anthropic-models.json), replaced by a user or
 *      update override at `<data dir>/anthropic-models.json` or `~/.muster/anthropic-models.json`;
 *   2. the model the user configured for Claude Code itself (`model` in ~/.claude/settings.json);
 *   3. the live Anthropic `/v1/models` list when ANTHROPIC_API_KEY is set (passed in; the key is never read here).
 * Every id is passed to the CLI as `--model <id>`. The family aliases stay last, labelled as aliases,
 * so chats already on one keep working.
 */
import {readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import bundled from '../catalogs/anthropic-models.json' with {type: 'json'};
import type {ProviderInfo} from '../../shared/protocol.ts';

type Model = ProviderInfo['models'][number];
type Effort = 'low' | 'medium' | 'high' | 'xhigh';
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];
export const CLAUDE_CODE_PREFIX = 'claude-code/';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@\[\]-]{0,127}$/;

/** Claude Code's own default (no --model flag) and the family aliases it resolves itself. */
export const CLAUDE_CODE_ALIASES: Model[] = [
  {id: 'claude-code/opus', name: 'Latest Opus (alias)'},
  {id: 'claude-code/sonnet', name: 'Latest Sonnet (alias)'},
  {id: 'claude-code/haiku', name: 'Latest Haiku (alias)'},
].map(model => ({...model, efforts: [...EFFORTS]}));
export const CLAUDE_CODE_DEFAULT: Model = {id: 'claude-code/default', name: 'Claude Code default', efforts: [...EFFORTS]};

/** Catalog entries → picker models. Malformed entries are skipped, never guessed at. */
export function parseClaudeCatalog(raw: unknown): Model[] {
  const list = raw && typeof raw === 'object' ? (raw as {models?: unknown}).models : undefined;
  if (!Array.isArray(list)) return [];
  const models: Model[] = [];
  for (const entry of list.slice(0, 200)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const id = value.id;
    if (typeof id !== 'string' || !MODEL_ID.test(id) || models.some(model => model.id === CLAUDE_CODE_PREFIX + id)) continue;
    const label = typeof value.displayName === 'string' && value.displayName.trim() ? value.displayName.replace(/[\x00-\x1f]/g, '').slice(0, 80) : id;
    const levels = Array.isArray(value.reasoningLevels) ? EFFORTS.filter(level => (value.reasoningLevels as unknown[]).includes(level)) : [];
    const fallback = EFFORTS.find(level => level === value.defaultReasoningLevel);
    const window = typeof value.contextWindow === 'number' && value.contextWindow > 0 ? value.contextWindow : undefined;
    models.push({id: CLAUDE_CODE_PREFIX + id, name: label, ...(levels.length ? {efforts: levels} : {}), ...(fallback && levels.includes(fallback) ? {defaultEffort: fallback} : {}),
      ...(window ? {contextWindow: window} : {}), ...(typeof value.images === 'boolean' ? {images: value.images} : {})});
  }
  return models;
}

function readJson(file: string): unknown {
  try { if (statSync(file).size > 1024 * 1024) return undefined; return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}
/** The first override that parses to at least one model, else the shipped catalog. */
export function claudeCatalog(options: {dataDir?: string; home?: string} = {}): {models: Model[]; source: string} {
  const home = options.home ?? homedir();
  for (const file of [options.dataDir ? join(options.dataDir, 'anthropic-models.json') : undefined, join(home, '.muster', 'anthropic-models.json')]) {
    if (!file) continue;
    const models = parseClaudeCatalog(readJson(file));
    if (models.length) return {models, source: file};
  }
  return {models: parseClaudeCatalog(bundled), source: 'Muster’s model catalog'};
}
/** `model` from Claude Code's own settings (CLAUDE_CONFIG_DIR or ~/.claude), when it names one. */
export function claudeSettingsModel(options: {env?: NodeJS.ProcessEnv; home?: string} = {}): string | undefined {
  const env = options.env ?? process.env, dir = env.CLAUDE_CONFIG_DIR || join(options.home ?? homedir(), '.claude');
  const model = (readJson(join(dir, 'settings.json')) as {model?: unknown} | undefined)?.model;
  return typeof model === 'string' && MODEL_ID.test(model.trim()) ? model.trim() : undefined;
}
const titleCase = (id: string) => id.replace(/^claude-/, 'Claude ').replace(/-(\d+)-(\d+)(?=$|-)/, ' $1.$2').replace(/-/g, ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase());

/** The full Claude Code picker list: catalog, the user's configured model, live API models, then default and aliases. */
export function claudeCodeModels(options: {dataDir?: string; home?: string; env?: NodeJS.ProcessEnv; live?: ReadonlyArray<{id: string; name: string}>} = {}): Model[] {
  const {models} = claudeCatalog(options);
  const out = [...models];
  const has = (id: string) => out.some(model => model.id === CLAUDE_CODE_PREFIX + id);
  const configured = claudeSettingsModel(options);
  if (configured && !['default', 'opus', 'sonnet', 'haiku'].includes(configured) && !has(configured)) out.push({id: CLAUDE_CODE_PREFIX + configured, name: `${titleCase(configured)} (your Claude Code setting)`, efforts: [...EFFORTS]});
  for (const model of options.live ?? []) if (MODEL_ID.test(model.id) && !has(model.id)) out.push({id: CLAUDE_CODE_PREFIX + model.id, name: model.name && model.name !== model.id ? model.name : titleCase(model.id), efforts: [...EFFORTS]});
  return [...out, CLAUDE_CODE_DEFAULT, ...CLAUDE_CODE_ALIASES];
}
