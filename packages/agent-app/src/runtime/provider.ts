import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Chat, ProviderInfo } from '../shared/protocol.ts';

export const MODEL = 'claude/claude-fable-5';
export interface ProviderInput {
  chat: Chat; cwd: string; prompt: string;
  onDelta(text: string): void;
  onReasoning(text: string): void;
  onEvent(method: string, params: Record<string, unknown>): void;
  onRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
}
export interface ProviderResult { status: 'completed' | 'failed'; finalMessage: string; threadId?: string; errorMessage?: string }
export interface ProviderAdapter {
  run(input: ProviderInput): Promise<ProviderResult>;
  stop(chatId: string): Promise<boolean>;
  dispose(): void;
  info(): ProviderInfo[];
}
interface CoreClient {
  runCodexAppServer(input: Record<string, unknown>): Promise<ProviderResult>;
  interruptActiveCodexTurn(owner: string, key: string): Promise<boolean>;
  clearCodexAppServerSessions(owner: string): void;
}
const OWNER = 'muster-agent-app';
const key = (id: string) => `agent:${id}:hybrow`;

/** Bundled from the existing headless core client; no VSCode or private provider APIs. */
export function createProviderAdapter(): ProviderAdapter {
  let core: CoreClient | undefined;
  const client = () => core ??= createRequire(__filename)(join(__dirname, 'core-client.cjs')) as CoreClient;
  const command = () => join(__dirname, 'resources', 'codex-hybrow-gateway.sh');
  return {
    info() {
      const configured = existsSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hybrow-gateway.config.toml'));
      const available = configured && existsSync(command());
      return [{ id: 'hybrow', name: 'Hybrow OmniRoute', available, identityMasked: 'Account hidden', models: [{ id: MODEL, name: 'Claude Fable 5' }], ...(!available ? { error: 'The existing Hybrow profile or packaged launcher is unavailable.' } : {}) }];
    },
    async run(input) {
      if (!this.info()[0]!.available) throw new Error('Hybrow is not configured. No alternate provider was used.');
      const node = process.env.MUSTER_PROVIDER_NODE || ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(existsSync) || 'node';
      return client().runCodexAppServer({
        prompt: input.prompt, cwd: input.cwd, command: command(), model: MODEL, reasoning: 'medium',
        env: { MUSTER_PROVIDER_NODE: node }, transportOwner: OWNER, cacheKey: key(input.chat.id),
        keepAlive: true, threadId: input.chat.providerThreadId,
        sandbox: input.chat.mode === 'agent' ? 'workspace-write' : 'read-only',
        networkAccess: false, approvalPolicy: 'on-request',
        developerInstructions: input.chat.mode === 'ask' ? 'Answer and inspect only. Do not modify files, execute mutations or request expanded access.' : input.chat.mode === 'plan' ? 'Produce a reviewable plan. Do not change files or request expanded access.' : undefined,
        collaborationMode: input.chat.mode === 'plan' ? { mode: 'plan', settings: { model: MODEL, reasoning_effort: 'medium' } } : undefined,
        configOverrides: ['agents.default_subagent_model="claude/claude-fable-5"', 'agents.default_subagent_reasoning_effort="medium"'],
        onDelta: input.onDelta, onReasoningDelta: input.onReasoning, onEvent: input.onEvent, onRequest: input.onRequest,
      });
    },
    async stop(id) { return core ? core.interruptActiveCodexTurn(OWNER, key(id)) : false; },
    dispose() { core?.clearCodexAppServerSessions(OWNER); },
  };
}
