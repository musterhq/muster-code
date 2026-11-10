import {chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {ProviderInfo} from '../shared/protocol.ts';
import {ACP_DRIVER, ACP_ID, acpPreset, ENV_NAME, joinArgs} from '../shared/acp-agents.ts';
import {acpModelRows, acpProbe, type AcpAgentSpec, type AcpCatalog} from './adapters/acp.ts';
import type {AgentSpawn} from './adapters/cli-common.ts';
import {activeSecretStore, type SecretStore} from './secret-store.ts';

/**
 * #160: ACP agents added in Settings › Providers. The command, arguments and the names of the variables are kept in
 * `acp-agents.json`; the variables' values live in the secret store (encrypted), never in a plain settings file.
 */
export interface AcpAgentRecord {
  id: string; name: string; command: string; args: string[];
  /** Names of the variables set for this agent; the values are in the secret store under the agent's id. */
  envNames: string[];
  preset?: string;
  checkedAt: string | null; error?: string;
  agentName?: string; version?: string; loadSession?: boolean;
  catalog?: Pick<AcpCatalog, 'models' | 'currentModel' | 'modes' | 'currentMode'>;
}
export interface AcpAgentInput { id?: unknown; name: unknown; command: unknown; args?: unknown; env?: unknown; preset?: unknown }

const live: AcpAgents[] = [];
export const activeAcpAgents = (): AcpAgents | undefined => live.at(-1);
const encodeEnv = (env: Record<string, string>) => Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
const decodeEnv = (value: string | undefined): Record<string, string> => { try { const parsed = value ? JSON.parse(Buffer.from(value, 'base64').toString('utf8')) : {}; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } };

export class AcpAgents {
  private readonly file: string;
  private records: AcpAgentRecord[];
  private checks = new Set<string>();
  private closed = false;
  constructor(readonly dataDir: string, private readonly options: {env?: NodeJS.ProcessEnv; home?: string; spawn?: AgentSpawn; secrets?: () => SecretStore | undefined} = {}) {
    this.file = join(dataDir, 'acp-agents.json');
    try { const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {agents?: unknown}; this.records = Array.isArray(raw.agents) ? raw.agents.filter(row => row && typeof row === 'object' && ACP_ID.test(String((row as AcpAgentRecord).id))) as AcpAgentRecord[] : []; } catch { this.records = []; }
    live.push(this);
  }
  private secrets() { return (this.options.secrets ?? activeSecretStore)(); }
  private persist() {
    mkdirSync(this.dataDir, {recursive: true});
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({version: 1, agents: this.records}, null, 2), {mode: 0o600});
    renameSync(temp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* filesystems without modes */ }
  }
  private claimed = false;
  /** Called by the provider catalog that lists ready agents itself, so list() does not repeat them. */
  claim(): void { this.claimed = true; }
  has(id: string): boolean { return this.records.some(row => row.id === id); }
  record(id: string): AcpAgentRecord | undefined { return this.records.find(row => row.id === id); }
  ready(row: AcpAgentRecord): boolean { return Boolean(row.checkedAt && !row.error); }
  /** What a run needs: the command, its arguments, the preset's sign-in variables and the stored values. */
  spec(row: AcpAgentRecord): AcpAgentSpec {
    const preset = acpPreset(row.preset);
    return {id: row.id, name: row.name, command: row.command, args: row.args, env: row.envNames.length ? decodeEnv(this.secrets()?.get(row.id)) : {}, envNames: preset?.envNames ?? [], ...(preset ? {installHint: preset.installHint} : {})};
  }
  agents(): AcpAgentRecord[] { return this.closed ? [] : [...this.records]; }
  info(row: AcpAgentRecord): ProviderInfo {
    const preset = acpPreset(row.preset), ready = this.ready(row), modes = row.catalog?.modes ?? [];
    return {id: row.id, name: row.name, driver: ACP_DRIVER, available: ready, status: ready ? 'ready' : row.error ? 'error' : 'configured', source: 'Added in Muster', identityMasked: 'Agent’s own sign-in', canReveal: false, custom: true,
      models: ready ? acpModelRows(row, row.catalog) : [], ...(row.checkedAt ? {checkedAt: row.checkedAt} : {}), ...(row.error ? {error: row.error} : {}),
      ...(preset ? {installUrl: preset.installUrl} : {}),
      acp: {command: row.command, args: row.args, envNames: row.envNames, ...(row.preset ? {preset: row.preset} : {})},
      detail: ready ? `Runs \`${[row.command, joinArgs(row.args)].filter(Boolean).join(' ')}\` over the Agent Client Protocol in the chat folder${row.agentName ? ` (${row.agentName}${row.version ? ` ${row.version}` : ''})` : ''}. Muster answers its approvals by the chat’s access level and serves its file reads and writes inside the folder.${modes.length ? ` Modes: ${modes.map(mode => mode.name).join(', ')}.` : ''}`
        : row.error ? `${row.error} No provider fallback will be used.` : 'Saved. Check it to start the agent once and read its models.'};
  }
  list(): ProviderInfo[] { return this.agents().filter(row => !this.claimed || !this.ready(row)).map(row => this.info(row)); }
  save(input: AcpAgentInput): ProviderInfo {
    if (this.closed) throw new Error('Provider settings are closing.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || /[\x00-\x1f]/.test(input.name)) throw new Error('Enter a name (up to 100 characters).');
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 1024 || /[\x00-\x1f]/.test(input.command)) throw new Error('Enter the command that starts the agent.');
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > 64 || !args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))) throw new Error('Enter up to 64 arguments.');
    const env = input.env ?? undefined;
    if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env) || Object.keys(env).length > 64 || !Object.entries(env).every(([name, value]) => ENV_NAME.test(name) && typeof value === 'string' && value.length <= 8192 && !value.includes('\0')))) throw new Error('Variables must be NAME=value, up to 64 of them.');
    if (input.preset !== undefined && (typeof input.preset !== 'string' || !acpPreset(input.preset))) throw new Error('Unknown preset.');
    const id = input.id === undefined ? `acp_${randomUUID()}` : input.id;
    if (typeof id !== 'string' || !ACP_ID.test(id)) throw new Error('Invalid agent.');
    const previous = this.record(id);
    if (input.id !== undefined && !previous) throw new Error('That agent no longer exists.');
    let envNames = previous?.envNames ?? [];
    if (env !== undefined) {
      const values = env as Record<string, string>;
      envNames = Object.keys(values).sort();
      const secrets = this.secrets();
      if (envNames.length) {
        if (!secrets) throw new Error('Secure storage is not open, so the variables were not saved.');
        const encoded = encodeEnv(values);
        if (encoded.length > 4096) throw new Error('The variables are too long to store (about 3,000 characters at most).');
        secrets.set(id, encoded);
      } else secrets?.clear(id);
    }
    const command = input.command.trim(), changed = !previous || previous.command !== command || JSON.stringify(previous.args) !== JSON.stringify(args) || env !== undefined;
    const row: AcpAgentRecord = {...(previous && !changed ? previous : {checkedAt: null}), id, name: input.name.trim(), command, args: [...args] as string[], envNames, ...(typeof input.preset === 'string' ? {preset: input.preset} : previous?.preset ? {preset: previous.preset} : {})};
    this.records = [...this.records.filter(entry => entry.id !== id), row].sort((a, b) => a.name.localeCompare(b.name));
    this.persist();
    return this.info(row);
  }
  remove(id: string): void { this.records = this.records.filter(row => row.id !== id); this.persist(); this.secrets()?.clear(id); }
  /** Starts the agent once in a scratch folder: the handshake, then one session for its models and modes. */
  async check(id: string): Promise<ProviderInfo> {
    if (this.closed) throw new Error('Provider settings are closing.');
    const row = this.record(id); if (!row) throw new Error('That agent no longer exists.');
    if (this.checks.has(id)) throw new Error('This agent is already being checked.');
    this.checks.add(id);
    const scratch = join(this.dataDir, 'acp-check');
    try {
      mkdirSync(scratch, {recursive: true});
      let update: Partial<AcpAgentRecord>;
      try {
        const found = await acpProbe(this.spec(row), {cwd: scratch, env: this.options.env, home: this.options.home, spawn: this.options.spawn});
        update = {checkedAt: new Date().toISOString(), error: undefined, agentName: found.agentName, version: found.version, loadSession: found.loadSession,
          catalog: {models: found.catalog.models, currentModel: found.catalog.currentModel, modes: found.catalog.modes, currentMode: found.catalog.currentMode}};
      } catch (error) { update = {checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error)}; }
      const current = this.record(id); if (!current || this.closed) throw new Error('That agent changed while it was checked.');
      const next = {...current, ...update}; if (!next.error) delete next.error;
      this.records = this.records.map(entry => entry.id === id ? next : entry);
      this.persist();
      return this.info(next);
    } finally { this.checks.delete(id); }
  }
  close(): void { if (this.closed) return; this.closed = true; const at = live.indexOf(this); if (at >= 0) live.splice(at, 1); }
}
