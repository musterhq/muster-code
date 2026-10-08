/**
 * What a Paperclip server agent runs on, in words (#307). The server stores an adapter (`claude_local`, `codex_local`, `process`,
 * `openclaw_gateway`, `hermes_local`, …) and, when the adapter has one, `adapterConfig.model`. Muster shows exactly that, and says so
 * when the server does not share a model. It never shows Muster's own default model for a server agent.
 */
export const RUNTIME_NAMES: Record<string, string> = {
  claude_local: 'Claude Code', codex_local: 'Codex', opencode_local: 'OpenCode', gemini_local: 'Gemini CLI', cursor_local: 'Cursor', cursor_cloud: 'Cursor Cloud',
  grok_local: 'Grok', kimi_local: 'Kimi', pi_local: 'Pi', hermes_local: 'Hermes', hermes_gateway: 'Hermes', openclaw_gateway: 'OpenClaw', openclaw: 'OpenClaw', hermes: 'Hermes',
  process: 'Process', http: 'HTTP', muster: 'Muster', codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', pi: 'Pi',
};
export const MODEL_NOT_SHARED = 'Model not shared by the server';

/** A readable model name for the ids Muster knows (claude-opus-4-7 → Opus 4.7, claude-sonnet-4-5-20250929 → Sonnet 4.5); any other id is shown as the server sent it. */
export function friendlyModel(model: string | null | undefined): string | null {
  const id = model?.trim();
  if (!id) return null;
  const claude = /^(?:[a-z]{2,4}\.)?(?:anthropic\.)?claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?(?:-v\d+:\d+)?(\[1m\])?$/i.exec(id);
  if (claude) { const family = claude[1]!; return `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}${claude[4] ? ' (1M)' : ''}`; }
  const bare = /^(opus|sonnet|haiku)$/i.exec(id);
  if (bare) return `${bare[1]![0]!.toUpperCase()}${bare[1]!.slice(1).toLowerCase()}`;
  return id;
}
/** The family a server model id belongs to, for "Opus on server": its friendly name without the version. */
export const serverModelName = (model: string | null | undefined): string | null => friendlyModel(model)?.replace(/\s+\d[\d.]*(?:\s+\(1M\))?$/, '') ?? null;

export const runtimeName = (adapter: string | null | undefined): string => adapter ? RUNTIME_NAMES[adapter] ?? adapter.replace(/_(local|gateway|cloud)$/, '').replace(/[_-]/g, ' ') : 'Unknown runtime';

/** "Claude Code · Opus 4.7", or "Process · Model not shared by the server". */
export const engineLabel = (adapter: string | null | undefined, model: string | null | undefined): string => `${runtimeName(adapter)} · ${friendlyModel(model) ?? MODEL_NOT_SHARED}`;
