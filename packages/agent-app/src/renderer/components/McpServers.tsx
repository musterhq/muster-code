import { Check, ChevronDown, ChevronRight, FileText, Pencil, Plus, Server, ShieldOff, Trash2, Webhook, Wrench, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { MCP_HOOK_LIMITS, type McpHook, type McpLogLine, type McpScope, type McpServer, type McpServerInput, type McpStage, type McpTestResult, type McpTool } from '../../shared/domains/mcp-protocol';
import { invoke } from '../bridge';
import { notifySuccess } from '../store';
import { useStore } from '../useStore';
import { ModalSheet } from './ModalSheet';
import './mcp-servers.css';
import { plural } from '../../shared/wording.ts';
import { agoLabel } from '../relativeTime.ts';
import { ResourceState } from './ResourceState';
import {Tip} from './Tooltip';

const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
const STAGES: McpStage[] = ['spawn', 'initialize', 'tools'];
const stageLabel = (stage: McpStage, transport: McpServer['transport']) => stage === 'spawn' ? transport === 'http' ? 'Connect' : 'Spawn' : stage === 'initialize' ? 'Initialize' : 'List tools';
const ago = (at?: string) => at ? agoLabel(at) : '';
type Panel = { kind: 'tools'; tools: McpTool[] | null; error?: string } | { kind: 'logs'; lines: McpLogLine[] } | null;
interface Draft { name: string; transport: 'stdio' | 'http'; command: string; args: string; env: string; url: string; auth: 'none' | 'bearer' | 'env'; envName: string; token: string; scope: string }
const blank: Draft = { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', auth: 'none', envName: 'API_TOKEN', token: '', scope: 'user' };
const toDraft = (server: McpServer): Draft => ({ name: server.name, transport: server.transport, command: server.command ?? '', args: server.args.join('\n'), env: Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join('\n'), url: server.url ?? '', auth: server.auth.kind, envName: server.auth.kind === 'env' ? server.auth.name : 'API_TOKEN', token: '', scope: server.scope === 'user' ? 'user' : `${server.scope}:${server.scopeId}` });
function toInput(draft: Draft): McpServerInput {
  const [scope, scopeId] = draft.scope === 'user' ? ['user', ''] : [draft.scope.slice(0, draft.scope.indexOf(':')), draft.scope.slice(draft.scope.indexOf(':') + 1)];
  const env: Record<string, string> = {};
  for (const line of draft.env.split('\n').map(item => item.trim()).filter(Boolean)) { const at = line.indexOf('='); if (at < 1) throw new Error(`Write environment variables as NAME=value (“${line}”).`); env[line.slice(0, at).trim()] = line.slice(at + 1); }
  const token = draft.token.trim() || undefined;
  const auth = draft.auth === 'bearer' ? { kind: 'bearer' as const, ...(token ? { token } : {}) } : draft.auth === 'env' ? { kind: 'env' as const, name: draft.envName.trim(), ...(token ? { token } : {}) } : { kind: 'none' as const };
  return { name: draft.name.trim(), transport: draft.transport, ...(draft.transport === 'stdio' ? { command: draft.command.trim(), args: draft.args.split('\n').map(item => item.trim()).filter(Boolean), env } : { url: draft.url.trim() }), auth, scope: scope as McpScope, scopeId };
}

/** MCP section of Plugins: user servers with connection tests, health, tool inspection, logs and revocation, plus plugin hook review. */
export function McpServers(): React.ReactElement {
  const state = useStore();
  const folders = state.snapshot?.folders ?? [], projects = state.snapshot?.projects ?? [];
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [hooks, setHooks] = useState<McpHook[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, McpTestResult>>({});
  const [panels, setPanels] = useState<Record<string, Panel>>({});
  const [revoking, setRevoking] = useState<McpServer | null>(null);
  const [removing, setRemoving] = useState<McpServer | null>(null);

  const reload = useCallback(async () => {
    // detect (not list) so the Codex config.toml / Claude mcpServers scan (DEF-MCP-EMPTY) stays current each time this screen opens.
    try { const [list, declared] = await Promise.all([invoke('mcp.servers.detect', undefined), invoke('mcp.hooks.list', undefined)]); setServers(list); setHooks(declared); setError(null); }
    catch (cause) { setError(message(cause)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const act = async (key: string, label: string, work: () => Promise<unknown>) => {
    setBusy(current => ({ ...current, [key]: label }));
    try { await work(); await reload(); } catch (cause) { setError(message(cause)); } finally { setBusy(({ [key]: _, ...rest }) => rest); }
  };
  const test = (server: McpServer) => act(server.id, 'Testing…', async () => {
    const result = await invoke('mcp.servers.test', { id: server.id });
    setResults(current => ({ ...current, [server.id]: result }));
    if (result.ok && panels[server.id]?.kind === 'tools') setPanels(current => ({ ...current, [server.id]: { kind: 'tools', tools: result.tools ?? [] } }));
    if (panels[server.id]?.kind === 'logs') { const lines = await invoke('mcp.servers.logs', { id: server.id }).catch(() => []); setPanels(current => ({ ...current, [server.id]: { kind: 'logs', lines } })); }
  });
  const togglePanel = async (server: McpServer, kind: 'tools' | 'logs') => {
    if (panels[server.id]?.kind === kind) { setPanels(current => ({ ...current, [server.id]: null })); return; }
    if (kind === 'logs') { setPanels(current => ({ ...current, [server.id]: { kind: 'logs', lines: [] } })); const lines = await invoke('mcp.servers.logs', { id: server.id }).catch(() => []); setPanels(current => ({ ...current, [server.id]: { kind: 'logs', lines } })); return; }
    setPanels(current => ({ ...current, [server.id]: { kind: 'tools', tools: null } }));
    try { const tools = await invoke('mcp.servers.tools', { id: server.id }); setPanels(current => ({ ...current, [server.id]: { kind: 'tools', tools } })); }
    catch (cause) { setPanels(current => ({ ...current, [server.id]: { kind: 'tools', tools: [], error: message(cause) } })); }
    void reload();
  };
  const save = async () => {
    if (!editing) return;
    let input: McpServerInput;
    try { input = toInput(editing.draft); } catch (cause) { setFormError(message(cause)); return; }
    setBusy(current => ({ ...current, form: 'Saving…' }));
    try {
      const saved = editing.id ? await invoke('mcp.servers.update', { ...input, id: editing.id }) : await invoke('mcp.servers.add', input);
      setEditing(null); setFormError(null); notifySuccess(editing.id ? `${saved.name} updated.` : `${saved.name} added. Testing the connection…`);
      await reload();
      if (!editing.id) void test(saved);
    } catch (cause) { setFormError(message(cause)); }
    finally { setBusy(({ form: _, ...rest }) => rest); }
  };
  const scopeName = (server: McpServer) => server.scope === 'user' ? 'Everywhere' : server.scope === 'folder' ? folders.find(folder => folder.id === server.scopeId)?.name ?? 'Removed folder' : projects.find(project => project.id === server.scopeId)?.name ?? 'Removed project';

  return <div className="mcp-servers">
    {error && <p className="settings-error" role="alert">{error}<button type="button" className="plugins-link" onClick={() => setError(null)} aria-label="Dismiss"><X size={12} /></button></p>}
    <div className="mcp-section-head"><h3><Server size={14} />MCP servers</h3>{!editing && <button type="button" className="plugins-secondary" onClick={() => { setEditing({ id: null, draft: blank }); setFormError(null); }}><Plus size={13} />Add server</button>}</div>
    {editing && <ServerForm draft={editing.draft} editingId={editing.id} stored={servers?.find(server => server.id === editing.id)?.auth} folders={folders} projects={projects} error={formError} busy={!!busy.form} onChange={draft => setEditing({ ...editing, draft })} onCancel={() => { setEditing(null); setFormError(null); }} onSave={() => void save()} />}
    {servers === null ? <ResourceState kind="loading" compact label="Loading servers" rows={2}/>
      : servers.length === 0 && !editing ? <p className="plugins-group-empty">No MCP servers yet. Add a local stdio command or a Streamable HTTP URL; each chat in scope gets its tools.</p>
      : <ul className="mcp-list" role="list">{servers.map(server => {
        const result = results[server.id], panel = panels[server.id], health = server.health;
        const tone = !server.enabled ? 'dim' : health.ok === false ? 'danger' : health.ok ? 'ok' : 'dim';
        const status = !server.enabled ? 'Disabled' : health.ok === false ? `Failing${health.consecutiveFailures > 1 ? ` ×${health.consecutiveFailures}` : ''}` : health.ok ? 'Healthy' : 'Not tested';
        const detected = server.source && server.source !== 'user';
        return <li key={server.id} className="mcp-server">
          <div className="mcp-server-row">
            <span className={`mcp-dot is-${tone}`} aria-hidden />
            <span className="mcp-server-text">
              <span className="mcp-server-title"><strong>{server.name}</strong>{detected && <span className="plugins-badge" title={`Detected from ${server.source === 'codex' ? "Codex's config.toml" : 'a Claude mcpServers config'}; its command, URL and environment values are read-only here`}>{server.source === 'codex' ? 'Codex' : 'Claude'}</span>}</span>
              <small><span className="mcp-tag">{server.transport === 'http' ? 'HTTP' : 'stdio'}</span>{server.transport === 'http' ? server.url : [server.command, ...server.args].join(' ')}</small>
              <em>{[status, health.latencyMs !== undefined ? `${health.latencyMs} ms` : '', health.toolCount !== undefined ? `${plural(health.toolCount, 'tool')}` : '', health.lastTestAt ? `tested ${ago(health.lastTestAt)}` : '', scopeName(server), server.auth.kind !== 'none' ? server.auth.stored ? 'token stored' : 'no token' : '', server.configKey !== server.name ? `as ${server.configKey}` : '', server.loadedBy.length ? `in use by ${plural(server.loadedBy.length, 'chat')}` : ''].filter(Boolean).join(' · ')}</em>
            </span>
            {busy[server.id] ? <span className="plugins-card-state">{busy[server.id]}</span> : <span className="mcp-actions">
              <button type="button" className="plugins-secondary" onClick={() => void test(server)}>Test</button>
              <Tip label="Tools"><button type="button" className="tool-button" aria-label={`Tools of ${server.name}`} aria-pressed={panel?.kind === 'tools'} onClick={() => void togglePanel(server, 'tools')}><Wrench size={14} /></button></Tip>
              <Tip label="Logs"><button type="button" className="tool-button" aria-label={`Logs of ${server.name}`} aria-pressed={panel?.kind === 'logs'} onClick={() => void togglePanel(server, 'logs')}><FileText size={14} /></button></Tip>
              {!detected && <Tip label="Edit"><button type="button" className="tool-button" aria-label={`Edit ${server.name}`} onClick={() => { setEditing({ id: server.id, draft: toDraft(server) }); setFormError(null); }}><Pencil size={14} /></button></Tip>}
              {server.enabled ? <Tip label="Revoke"><button type="button" className="tool-button" aria-label={`Revoke ${server.name}`} onClick={() => setRevoking(server)}><ShieldOff size={14} /></button></Tip> : <span className="tool-button mcp-action-slot" aria-hidden="true" />}
              {!detected && <Tip label="Remove"><button type="button" className="tool-button" aria-label={`Remove ${server.name}`} onClick={() => setRemoving(server)}><Trash2 size={14} /></button></Tip>}
              <button type="button" role="switch" aria-checked={server.enabled} aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name}`} className="plugins-switch" onClick={() => void act(server.id, server.enabled ? 'Disabling…' : 'Enabling…', () => invoke('mcp.servers.update', { id: server.id, enabled: !server.enabled }))}><span /></button>
            </span>}
          </div>
          {(result || health.ok === false) && <Stages server={server} result={result} />}
          {panel?.kind === 'tools' && <ToolList panel={panel} onRefresh={() => void test(server)} />}
          {panel?.kind === 'logs' && <pre className="mcp-logs" aria-label={`Logs of ${server.name}`}>{panel.lines.length ? panel.lines.map(line => `${line.at.slice(11, 19)} ${line.stream.padEnd(6)} ${line.text}`).join('\n') : 'No log lines yet. Run a test to capture the handshake.'}</pre>}
        </li>;
      })}</ul>}
    <HookReview hooks={hooks} onChange={setHooks} onError={setError} />
    <ModalSheet open={!!revoking} className="composer-access-dialog project-confirm" title={`Revoke ${revoking?.name ?? ''}?`} description={revoking?.loadedBy.length ? `New runs stop loading it now. These running chats already loaded it and keep its tools until they finish: ${revoking.loadedBy.map(chat => chat.title).join(', ')}.` : 'New runs stop loading it now. No running chat has it loaded.'} onClose={() => setRevoking(null)}>
      <div><button type="button" onClick={() => setRevoking(null)}>Cancel</button>
        {!!revoking?.loadedBy.length && <button type="button" className="is-danger" onClick={() => { const server = revoking; setRevoking(null); void act(server.id, 'Revoking…', async () => { const done = await invoke('mcp.revoke', { id: server.id, stopChats: true }); notifySuccess(`${server.name} revoked; stopped ${plural(done.stopped.length, 'chat')}.`); }); }}>Revoke and stop {revoking.loadedBy.length}</button>}
        <button type="button" className="is-danger" onClick={() => { const server = revoking!; setRevoking(null); void act(server.id, 'Revoking…', async () => { await invoke('mcp.revoke', { id: server.id }); notifySuccess(`${server.name} revoked.`); }); }}>Revoke</button></div>
    </ModalSheet>
    <ModalSheet open={!!removing} className="composer-access-dialog project-confirm" title={`Remove ${removing?.name ?? ''}?`} description="Its settings, stored token and logs are deleted." onClose={() => setRemoving(null)}>
      <div><button type="button" onClick={() => setRemoving(null)}>Cancel</button><button type="button" className="is-danger" onClick={() => { const server = removing!; setRemoving(null); void act(server.id, 'Removing…', () => invoke('mcp.servers.remove', { id: server.id })); }}>Remove</button></div>
    </ModalSheet>
  </div>;
}

function Stages({ server, result }: { server: McpServer; result?: McpTestResult }): React.ReactElement {
  const stage = result?.stage ?? server.health.stage ?? 'spawn', ok = result?.ok ?? server.health.ok, error = result?.error ?? server.health.error;
  const reached = STAGES.indexOf(stage);
  return <div className="mcp-stages" role="status">
    <ol>{STAGES.map((item, index) => { const state = index < reached || (index === reached && ok) ? 'ok' : index === reached ? 'failed' : 'skipped'; return <li key={item} className={`is-${state}`}>{state === 'ok' ? <Check size={12} /> : state === 'failed' ? <X size={12} /> : <span />}{stageLabel(item, server.transport)}</li>; })}
      {result && <li className="mcp-stage-time">{result.latencyMs} ms{result.serverInfo ? ` · ${result.serverInfo.name}${result.serverInfo.version ? ` ${result.serverInfo.version}` : ''}` : ''}</li>}</ol>
    {!ok && error && <p className="mcp-stage-error">{error}</p>}
  </div>;
}

function ToolList({ panel, onRefresh }: { panel: Extract<Panel, { kind: 'tools' }>; onRefresh(): void }): React.ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  if (!panel.tools) return <ResourceState kind="loading" compact label="Loading tools" rows={2}/>;
  return <div className="mcp-tools">
    {panel.error ? <p className="mcp-stage-error">{panel.error}</p> : !panel.tools.length ? <p className="plugins-group-empty">This server lists no tools.</p>
      : <ul role="list">{panel.tools.map(tool => <li key={tool.name}>
        <button type="button" className="mcp-tool" aria-expanded={open === tool.name} onClick={() => setOpen(open === tool.name ? null : tool.name)}>{open === tool.name ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<code>{tool.name}</code><span>{tool.title ?? tool.description ?? ''}</span></button>
        {open === tool.name && <div className="mcp-tool-detail">{tool.description && <p>{tool.description}</p>}<pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></div>}
      </li>)}</ul>}
    <button type="button" className="plugins-link" onClick={onRefresh}>Test again to refresh</button>
  </div>;
}

function ServerForm({ draft, editingId, stored, folders, projects, error, busy, onChange, onCancel, onSave }: { draft: Draft; editingId: string | null; stored?: McpServer['auth']; folders: Array<{ id: string; name: string }>; projects: Array<{ id: string; name: string }>; error: string | null; busy: boolean; onChange(draft: Draft): void; onCancel(): void; onSave(): void }): React.ReactElement {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value, ...(key === 'transport' ? { auth: 'none' } : {}) });
  const hasToken = !!stored && stored.kind !== 'none' && stored.stored && stored.kind === draft.auth;
  return <form className="mcp-form" onSubmit={event => { event.preventDefault(); onSave(); }} aria-label={editingId ? 'Edit MCP server' : 'Add MCP server'}>
    <div className="mcp-form-grid">
      <label>Name<input value={draft.name} onChange={event => set('name', event.target.value)} placeholder="github" autoFocus required maxLength={64} /></label>
      <label>Transport<div className="mcp-segmented" role="radiogroup">{(['stdio', 'http'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={draft.transport === value} className={draft.transport === value ? 'is-active' : ''} onClick={() => set('transport', value)}>{value === 'stdio' ? 'Local (stdio)' : 'Streamable HTTP'}</button>)}</div></label>
      {draft.transport === 'stdio' ? <>
        <label className="is-wide">Command<input value={draft.command} onChange={event => set('command', event.target.value)} placeholder="npx" spellCheck={false} required /></label>
        <label>Arguments <small>one per line</small><textarea rows={3} value={draft.args} onChange={event => set('args', event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-github'} spellCheck={false} /></label>
        <label>Environment <small>NAME=value per line</small><textarea rows={3} value={draft.env} onChange={event => set('env', event.target.value)} placeholder="LOG_LEVEL=info" spellCheck={false} /></label>
      </> : <label className="is-wide">URL<input type="url" value={draft.url} onChange={event => set('url', event.target.value)} placeholder="https://example.com/mcp" spellCheck={false} required /></label>}
      <label>Authentication<select value={draft.auth} onChange={event => set('auth', event.target.value as Draft['auth'])}>
        <option value="none">None</option>
        {draft.transport === 'http' ? <option value="bearer">Bearer token</option> : <option value="env">Token in environment variable</option>}
      </select></label>
      <label>Scope<select value={draft.scope} onChange={event => set('scope', event.target.value)}>
        <option value="user">User (every chat)</option>
        {folders.length > 0 && <optgroup label="Folder">{folders.map(folder => <option key={folder.id} value={`folder:${folder.id}`}>{folder.name}</option>)}</optgroup>}
        {projects.length > 0 && <optgroup label="Project">{projects.map(project => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}</optgroup>}
      </select></label>
      {draft.auth === 'env' && <label>Variable name<input value={draft.envName} onChange={event => set('envName', event.target.value)} spellCheck={false} pattern="[A-Za-z_][A-Za-z0-9_]*" required /></label>}
      {draft.auth !== 'none' && <label>Token<input type="password" value={draft.token} onChange={event => set('token', event.target.value)} placeholder={hasToken ? 'Stored — leave blank to keep' : 'Paste token'} autoComplete="off" /><small>Kept in the Keychain-backed secret store, never in settings.</small></label>}
    </div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="mcp-form-actions"><button type="button" className="plugins-secondary" onClick={onCancel}>Cancel</button><button type="submit" className="plugins-primary" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save' : 'Add and test'}</button></div>
  </form>;
}

function HookReview({ hooks, onChange, onError }: { hooks: McpHook[]; onChange(hooks: McpHook[]): void; onError(error: string): void }): React.ReactElement {
  const [confirming, setConfirming] = useState<McpHook | null>(null);
  const set = async (id: string, patch: { enabled?: boolean; timeoutSec?: number; maxOutputKb?: number }) => { try { onChange(await invoke('mcp.hooks.set', { id, ...patch })); } catch (cause) { onError(message(cause)); } };
  return <section className="mcp-hooks">
    <div className="mcp-section-head"><h3><Webhook size={14} />Plugin hooks</h3></div>
    <p className="plugins-scope-note">Hooks declared by installed plugins. Nothing runs until you review and enable it. SessionStart and UserPromptSubmit output is added to the prompt only when the hook finishes within 2 seconds; Stop runs after each turn.</p>
    {!hooks.length ? <p className="plugins-group-empty">No installed plugin declares hooks.</p> : <ul className="mcp-list" role="list">{hooks.map(hook => <li key={hook.id} className="mcp-server">
      <div className="mcp-server-row">
        <span className={`mcp-dot is-${hook.enabled ? 'ok' : 'dim'}`} aria-hidden />
        <span className="mcp-server-text"><strong>{hook.extensionName} · {hook.event}{hook.matcher ? ` (${hook.matcher})` : ''}</strong><small><code>{hook.command}</code></small>
          <em>{!hook.supported ? hook.reason : hook.lastRun ? `Last run ${ago(hook.lastRun.at)} · ${hook.lastRun.timedOut ? 'timed out' : `exit ${hook.lastRun.exitCode ?? '—'}`} · ${hook.lastRun.durationMs} ms${hook.lastRun.truncated ? ' · output truncated' : ''}` : hook.enabled ? 'Enabled · not run yet' : 'Not enabled'}</em></span>
        {hook.supported && <span className="mcp-actions">
          <label className="mcp-limit">Timeout<input key={`timeout-${hook.id}-${hook.timeoutSec}`} type="number" min={MCP_HOOK_LIMITS.timeoutSec.min} max={MCP_HOOK_LIMITS.timeoutSec.max} defaultValue={hook.timeoutSec} onBlur={event => { const value = Number(event.target.value); if (value !== hook.timeoutSec) void set(hook.id, { timeoutSec: value }); }} aria-label="Timeout in seconds" />s</label>
          <label className="mcp-limit">Output<input key={`output-${hook.id}-${hook.maxOutputKb}`} type="number" min={MCP_HOOK_LIMITS.maxOutputKb.min} max={MCP_HOOK_LIMITS.maxOutputKb.max} defaultValue={hook.maxOutputKb} onBlur={event => { const value = Number(event.target.value); if (value !== hook.maxOutputKb) void set(hook.id, { maxOutputKb: value }); }} aria-label="Output cap in KB" />KB</label>
          {hook.enabled ? <button type="button" className="plugins-secondary" onClick={() => void set(hook.id, { enabled: false })}>Disable</button> : <button type="button" className="plugins-secondary" onClick={() => setConfirming(hook)}>Review and enable</button>}
        </span>}
      </div>
      {hook.lastRun?.output && <pre className="mcp-logs">{hook.lastRun.output}</pre>}
    </li>)}</ul>}
    <ModalSheet open={!!confirming} className="composer-access-dialog project-confirm" title={`Enable ${confirming?.event ?? ''} hook from ${confirming?.extensionName ?? ''}?`} description={`This shell command will run on your Mac with your user permissions, in the plugin folder, for chats where the plugin is enabled. It is killed after ${confirming?.timeoutSec ?? 0}s and its output is capped at ${confirming?.maxOutputKb ?? 0} KB.`} onClose={() => setConfirming(null)}>
      <pre className="mcp-logs">{confirming?.command}</pre>
      <div><button type="button" onClick={() => setConfirming(null)}>Cancel</button><button type="button" className="is-danger" onClick={() => { const hook = confirming!; setConfirming(null); void set(hook.id, { enabled: true }); }}>Enable hook</button></div>
    </ModalSheet>
  </section>;
}
