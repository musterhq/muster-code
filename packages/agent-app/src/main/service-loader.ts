import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentEvent, Commands } from '../shared/protocol.ts';

export interface AgentService {
  invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']>;
  dispose(): Promise<void>;
}

export interface ServiceOptions {
  dataDir: string;
  onEvent: (event: AgentEvent) => void;
}

/** Loads the runtime worker's `createAgentService` if its bundle was built
 *  (`dist/runtime/service.cjs`, produced when `src/runtime/service.ts` exists).
 *  Absent runtime → honest fallback so the shell still launches standalone:
 *  it serves an empty snapshot and rejects runtime commands with a clear error. */
export function loadAgentService(options: ServiceOptions): { service: AgentService; runtimeLoaded: boolean } {
  // Bundle output is CJS (dist/main/index.cjs): __filename is real there,
  // while import.meta.url would be rewritten away by esbuild.
  const require = createRequire(__filename);
  try {
    const mod = require(path.join(__dirname, '../runtime/service.cjs')) as {
      createAgentService(options: ServiceOptions): AgentService;
    };
    return { service: mod.createAgentService(options), runtimeLoaded: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return { service: createFallbackService(options), runtimeLoaded: false };
  }
}

function createFallbackService({ onEvent }: ServiceOptions): AgentService {
  const snapshot = { folders: [], chats: [], projects: [], version: 0 };
  return {
    async invoke(command, input) {
      void input;
      if (command === 'app.snapshot') return snapshot as Commands[typeof command]['output'];
      queueMicrotask(() => onEvent({ type: 'notice', message: 'Agent runtime is not built; command unavailable.' }));
      throw new Error(`Agent runtime is not built; cannot run '${command}'.`);
    },
    async dispose() {},
  };
}
