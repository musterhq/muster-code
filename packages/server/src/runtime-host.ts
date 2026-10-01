/**
 * Hosts the desktop app's Electron-free agent runtime (dist/runtime/service.cjs) in plain Node.
 *
 * The runtime asks `require('electron')` for exactly two things: `safeStorage` (secret encryption) and, optionally, `app`/`BrowserWindow`
 * for desktop-only actions. Here `electron` resolves to a stand-in that offers only the server secret box, so secrets are encrypted with the
 * server key and every desktop-only branch takes its existing "needs the desktop app" path.
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, Commands, Snapshot } from '../../agent-app/src/shared/protocol.ts';
import type { SecretBox } from './secret-box.ts';

export interface RuntimeService {
  invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']>;
  dispose(): Promise<void>;
}
type Invoke = (command: string, input: unknown) => Promise<unknown>;

/** CJS bundle: the real file; ESM tests: the working directory (only used to build a require). */
const HERE = typeof __filename === 'string' ? __filename : join(process.cwd(), 'index.js');
const HERE_DIR = typeof __dirname === 'string' ? __dirname : process.cwd();
const STAND_IN = 'muster-server-electron-stand-in';
let installed: { safeStorage: SecretBox } | undefined;
/** Installs the `electron` stand-in once per process. */
export function installElectronStandIn(box: SecretBox): void {
  if (installed) { installed.safeStorage = box; return; }
  installed = { safeStorage: box };
  const M = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string; _cache?: Record<string, unknown> };
  const original = M._resolveFilename;
  M._resolveFilename = function (request: string, ...rest: unknown[]) { return request === 'electron' ? STAND_IN : original.call(this, request, ...rest); };
  const cache = (createRequire(HERE).cache ?? {}) as Record<string, unknown>;
  cache[STAND_IN] = { id: STAND_IN, filename: STAND_IN, loaded: true, exports: installed };
}

export function resolveRuntimeDir(explicit?: string): string {
  const candidates = [explicit, process.env.MUSTER_SERVER_RUNTIME_DIR, join(HERE_DIR, 'runtime'), join(HERE_DIR, '..', '..', 'agent-app', 'dist', 'runtime'), join(HERE_DIR, '..', 'dist', 'runtime')]
    .filter((p): p is string => typeof p === 'string');
  const found = candidates.find(p => existsSync(join(p, 'service.cjs')));
  if (!found) throw new Error(`Agent runtime bundle not found (looked in ${candidates.join(', ')}). Build packages/agent-app first (npm run build) or set MUSTER_SERVER_RUNTIME_DIR.`);
  return found;
}

export class RuntimeHost {
  private service?: RuntimeService;
  private listeners = new Set<(event: AgentEvent) => void>();
  private cached?: Snapshot;
  constructor(private readonly options: { dataDir: string; runtimeDir: string; box: SecretBox; provider?: unknown }) {}

  start(): void {
    installElectronStandIn(this.options.box);
    mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
    const mod = createRequire(HERE)(join(this.options.runtimeDir, 'service.cjs')) as { createAgentService(o: unknown): RuntimeService };
    if (typeof mod.createAgentService !== 'function') throw new Error('Invalid agent runtime bundle.');
    this.service = mod.createAgentService({
      dataDir: this.options.dataDir,
      ...(this.options.provider ? { provider: this.options.provider } : {}),
      onEvent: (event: AgentEvent) => {
        if (event.type === 'snapshot') this.cached = event.snapshot;
        for (const listener of [...this.listeners]) { try { listener(event); } catch (error) { console.error('[muster-server] event listener failed', error); } }
      },
    });
  }
  get running(): boolean { return Boolean(this.service); }
  invoke: Invoke = async (command, input) => {
    if (!this.service) throw new Error('The agent runtime is not running.');
    return (this.service.invoke as unknown as Invoke)(command, input);
  };
  async snapshot(fresh = false): Promise<Snapshot> {
    if (fresh || !this.cached) this.cached = await this.invoke('app.snapshot', undefined) as Snapshot;
    return this.cached;
  }
  cachedSnapshot(): Snapshot { return this.cached ?? { folders: [], chats: [], projects: [], version: 0 }; }
  subscribe(listener: (event: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async dispose(): Promise<void> { const s = this.service; this.service = undefined; this.listeners.clear(); await s?.dispose(); }
}
