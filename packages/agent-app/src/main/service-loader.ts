import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentEvent, Commands } from '../shared/protocol.ts';

export interface AgentService {
  invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']>;
  dispose(): Promise<void>;
  /** SBX-13: Electron powerMonitor sleep/wake. Optional so an older runtime bundle still loads. */
  power?(input: { state: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen' }): Promise<unknown>;
}

export interface ServiceOptions {
  dataDir: string;
  onEvent: (event: AgentEvent) => void;
  /** Live user-owned process groups (terminals, Commands tab); the agent is told never to stop them. */
  userProcesses?: () => readonly { pgid: number; label: string; chatId: string; cwd?: string }[];
  /** R5: user groups with ports/PIDs/names, so agent kill commands aimed at them always need approval. */
  userProcessTargets?: () => Promise<readonly { pgid: number; label: string; chatId: string; cwd?: string; pids?: readonly number[]; pgids?: readonly number[]; ports?: readonly number[]; names?: readonly string[] }[]>;
}

/** A missing or broken runtime is a startup failure, never a fake empty app. */
export function loadAgentService(options: ServiceOptions): { service: AgentService; runtimeLoaded: boolean } {
  const require = createRequire(__filename);
  const mod = require(path.join(__dirname, '../runtime/service.cjs')) as {
    createAgentService(options: ServiceOptions): AgentService;
  };
  if (typeof mod.createAgentService !== 'function') throw new Error('Invalid agent runtime bundle.');
  return { service: mod.createAgentService(options), runtimeLoaded: true };
}
