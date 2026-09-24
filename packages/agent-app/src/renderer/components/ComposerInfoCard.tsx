import { Copy, Gauge, Server, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { Chat, ContextTelemetry, PluginEntry } from '../../shared/protocol';
import type { McpServer } from '../../shared/domains/mcp-protocol';
import { formatCount, plural } from '../../shared/wording.ts';
import { invoke } from '../bridge';
import { copyText } from '../clipboard';
import { notifyError, openPluginsScreen } from '../store';
import { ProviderUsageMeters, reportsUsage, useProviderUsage } from './ProviderUsage';
import {Tip} from './Tooltip';

export type InfoView = 'status' | 'mcp';

/** `/status` context line: "42% used · 84K of 200K tokens", or why it is unknown. */
export function contextUsageLine(telemetry: ContextTelemetry | null | undefined): string {
  if (!telemetry || telemetry.usedTokens === null) return 'Not reported yet · the provider reports usage after a turn';
  const used = formatCount(telemetry.usedTokens);
  if (!telemetry.windowTokens) return `${used} tokens used`;
  const percent = Math.min(100, Math.round(telemetry.usedTokens / telemetry.windowTokens * 100));
  return `${percent}% used · ${used} of ${formatCount(telemetry.windowTokens)} tokens${telemetry.compacted ? ' · compacted' : ''}`;
}

/** `/mcp` status word for one server: disabled, untested, failing (with the stage) or healthy with its tool count. */
export function mcpServerState(server: Pick<McpServer, 'enabled' | 'healthy' | 'health'>): { tone: 'ok' | 'warn' | 'off'; label: string } {
  if (!server.enabled) return { tone: 'off', label: 'Disabled' };
  if (!server.health.lastTestAt) return { tone: 'warn', label: 'Not tested yet' };
  if (!server.healthy || server.health.ok === false) return { tone: 'warn', label: `Failing at ${server.health.stage ?? 'start'}${server.health.error ? ` · ${server.health.error}` : ''}` };
  return { tone: 'ok', label: typeof server.health.toolCount === 'number' ? `Ready · ${plural(server.health.toolCount, 'tool')}` : 'Ready' };
}

function StatusCard({ chat, modelName, accessLabel }: { chat: Chat; modelName: string; accessLabel: string }): React.ReactElement {
  const [telemetry, setTelemetry] = useState<ContextTelemetry | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void invoke('chat.contextTelemetry', { id: chat.id }).then(value => { if (live) setTelemetry(value ?? null); }, () => { if (live) setTelemetry(null); });
    return () => { live = false; };
  }, [chat.id]);
  const providerId = chat.providerId ?? 'hybrow', usage = useProviderUsage(providerId, true);
  return <dl className="composer-info-rows">
    <div><dt>Chat ID</dt><dd><code>{chat.id}</code><Tip label="Copy chat ID"><button type="button" className="composer-info-copy" aria-label="Copy chat ID" onClick={() => void copyText(chat.id).catch(notifyError)}><Copy size={11} /></button></Tip></dd></div>
    {chat.providerThreadId && <div><dt>Provider thread</dt><dd><code>{chat.providerThreadId}</code></dd></div>}
    <div><dt>Model</dt><dd>{modelName} · {providerId}</dd></div>
    <div><dt>Access</dt><dd>{accessLabel}</dd></div>
    <div><dt>Context</dt><dd data-testid="status-context">{telemetry === undefined ? 'Reading…' : contextUsageLine(telemetry)}</dd></div>
    <div className="is-block"><dt>Rate limits</dt><dd>{reportsUsage(providerId) ? <ProviderUsageMeters usage={usage.usage} loaded={usage.loaded} /> : 'This provider does not report rate limits.'}</dd></div>
  </dl>;
}

function McpCard({ plugins }: { plugins: readonly PluginEntry[] }): React.ReactElement {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void invoke('mcp.servers.list', undefined).then(value => { if (live) setServers(Array.isArray(value) ? value : []); }, cause => { if (live) { setServers([]); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { live = false; };
  }, []);
  const bundled = plugins.flatMap(plugin => plugin.mcpServers.map(server => ({ key: `${plugin.id}:${server.name}`, name: server.name, plugin: plugin.displayName ?? plugin.name, transport: server.transport })));
  if (servers === null) return <p className="composer-info-note" role="status">Reading MCP servers…</p>;
  return <>
    {error && <p className="composer-info-note is-error" role="alert">{error}</p>}
    {!servers.length && !bundled.length && !error && <p className="composer-info-note">No MCP servers configured. Add one in Settings › Skills &amp; plugins.</p>}
    {servers.length > 0 && <ul className="composer-info-list" aria-label="MCP servers">
      {servers.map(server => { const state = mcpServerState(server);
        return <li key={server.id} data-testid="mcp-status-row"><span className={`composer-info-dot is-${state.tone}`} aria-hidden="true" /><strong>{server.name}</strong>
          <span className="composer-info-meta">{server.transport === 'http' ? 'HTTP' : 'stdio'}{server.source && server.source !== 'user' ? ` · from ${server.source === 'codex' ? 'Codex' : 'Claude'}` : ''}</span>
          <span className="composer-info-state">{state.label}</span>
          {server.loadedBy.length > 0 && <span className="composer-info-meta">in use by {plural(server.loadedBy.length, 'running chat')}</span>}</li>; })}
    </ul>}
    {bundled.length > 0 && <><p className="composer-info-subhead">From plugins</p><ul className="composer-info-list" aria-label="Plugin MCP servers">
      {bundled.map(server => <li key={server.key}><span className="composer-info-dot is-ok" aria-hidden="true" /><strong>{server.name}</strong><span className="composer-info-meta">{server.plugin} · {server.transport}</span></li>)}
    </ul></>}
  </>;
}

/** `/status` and `/mcp`: a read-only card in the goal-strip slot above the composer; Esc or × closes it. */
export function ComposerInfoCard({ view, chat, modelName, accessLabel, plugins, onClose }: { view: InfoView; chat: Chat; modelName: string; accessLabel: string; plugins: readonly PluginEntry[]; onClose(): void }): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const Icon = view === 'status' ? Gauge : Server;
  return <section className="composer-info" data-testid={`composer-info-${view}`} aria-label={view === 'status' ? 'Chat status' : 'MCP server status'}>
    <header className="composer-info-head"><Icon size={13} aria-hidden="true" /><span>{view === 'status' ? 'Status' : 'MCP servers'}</span>
      {view === 'mcp' && <button type="button" className="composer-info-link" onClick={() => { onClose(); openPluginsScreen('plugins'); }}>Manage</button>}
      <button type="button" className="composer-info-close" aria-label="Close" onClick={onClose}><X size={12} /></button></header>
    {view === 'status' ? <StatusCard chat={chat} modelName={modelName} accessLabel={accessLabel} /> : <McpCard plugins={plugins} />}
  </section>;
}
