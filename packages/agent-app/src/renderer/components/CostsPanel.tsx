/**
 * Costs and provider limits (G24): what the work cost over the last 7, 30 or 90 days by model, agent, project and day, and
 * how much of each provider's rate-limit windows is used. Read from the Ledger by the runtime (`insight.costs`); a turn with
 * no known price reads "Unpriced", never $0, and your own price from Settings › Models prices turns the catalog could not.
 */
import { RefreshCw } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { CostBucket, CostsReport } from '../../shared/domains/insight-protocol';
import { formatTokenCount, formatUsd } from '../../shared/model-catalog';
import { invoke } from '../bridge';
import { Bars } from './DashboardPage';
import { ProviderUsageMeters } from './ProviderUsage';
import { ResourceState } from './ResourceState';
import './costs-panel.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export const costText = (b: Pick<CostBucket, 'costUsd' | 'unpricedTurns' | 'turns'>): string => b.costUsd === null ? (b.turns ? 'Unpriced' : '—') : b.unpricedTurns ? `${formatUsd(b.costUsd)} + unpriced` : formatUsd(b.costUsd);
const DAYS = [7, 30, 90] as const;

function Table({ title, rows, empty }: { title: string; rows: CostBucket[]; empty: string }): React.ReactElement {
  const top = Math.max(1, ...rows.map(r => r.costUsd ?? 0));
  return <section className="costs-table" aria-label={title}>
    <h3 className="ws-group-title">{title}<span>{rows.length}</span></h3>
    {rows.length === 0 ? <p className="ws-board-empty">{empty}</p>
      : <table><thead><tr><th scope="col">{title.replace(/^By /, '')}</th><th scope="col" className="numeric">Turns</th><th scope="col" className="numeric">Tokens</th><th scope="col" className="numeric">Cost</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.key}>
          <th scope="row"><span className="costs-label" title={r.label}>{r.label}</span>{r.costUsd !== null && <span className="costs-share" aria-hidden="true"><span style={{ width: `${Math.max(2, Math.round((r.costUsd / top) * 100))}%` }}/></span>}</th>
          <td className="numeric">{r.turns}</td><td className="numeric" title={`${r.inputTokens.toLocaleString('en-US')} in · ${r.outputTokens.toLocaleString('en-US')} out`}>{formatTokenCount(r.inputTokens + r.outputTokens)}</td>
          <td className="numeric" title={r.unpricedTurns ? `${r.unpricedTurns} of ${r.turns} turns have no known price` : undefined}>{costText(r)}</td>
        </tr>)}</tbody></table>}
  </section>;
}

/** `projectId` scopes it to one project (the project page's Ledger tab); the provider windows then stay out of it. */
export function CostsPanel({ projectId }: { projectId?: string }): React.ReactElement {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [report, setReport] = useState<CostsReport | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true; setError('');
    invoke('insight.costs', { days, utcOffsetMinutes: -new Date().getTimezoneOffset(), ...(projectId ? { projectId } : {}) }).then(r => { if (live) setReport(r); }, e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [days, projectId, tick]);
  if (error) return <ResourceState kind="error" message="Costs could not be read." detail={error} onRetry={() => setTick(n => n + 1)}/>;
  if (!report) return <ResourceState kind="loading" label="Reading the Ledger" rows={4}/>;
  const t = report.totals, priced = report.byDay.some(d => d.costUsd !== null);
  const span = `Last ${report.days} days`;
  return <div className="costs" aria-label="Costs">
    <div className="costs-bar">
      <div className="ws-segmented is-inline" role="radiogroup" aria-label="Period">{DAYS.map(d => <button key={d} type="button" role="radio" aria-checked={days === d} className="ws-segment" onClick={() => setDays(d)}><span className="ws-segment-label">{d} days</span></button>)}</div>
      <span className="task-toolbar-spacer"/>
      <button type="button" className="icon-button" aria-label="Refresh costs" onClick={() => setTick(n => n + 1)}><RefreshCw size={14}/></button>
    </div>
    <section className="costs-tiles" aria-label="Totals">
      <div className="dash-tile is-static"><span className="dash-value">{costText(t)}</span><span className="dash-tile-label">Estimated cost</span><span className="dash-tile-detail">{t.unpricedTurns ? `${t.unpricedTurns} unpriced ${t.unpricedTurns === 1 ? 'turn' : 'turns'} left out` : span}</span></div>
      <div className="dash-tile is-static"><span className="dash-value">{formatTokenCount(t.inputTokens + t.outputTokens)}</span><span className="dash-tile-label">Tokens</span><span className="dash-tile-detail">{formatTokenCount(t.inputTokens)} in · {formatTokenCount(t.outputTokens)} out</span></div>
      <div className="dash-tile is-static"><span className="dash-value">{t.turns}</span><span className="dash-tile-label">Agent turns</span><span className="dash-tile-detail">{report.byAgent.length} {report.byAgent.length === 1 ? 'agent' : 'agents'} · {report.byProject.length} {report.byProject.length === 1 ? 'project' : 'projects'}</span></div>
    </section>
    <div className="dash-card costs-chart"><Bars title={priced ? 'Spend per day' : 'Tokens per day'} span={span} days={report.byDay.map(d => d.day)}
      max={Math.max(1e-9, ...report.byDay.map(d => priced ? d.costUsd ?? 0 : d.tokens))}
      series={report.byDay.map(d => [{ key: 'v', label: priced ? 'Spend' : 'Tokens', value: priced ? d.costUsd ?? 0 : d.tokens, tone: 'accent' }])} legend={[{ label: priced ? 'Estimated spend (priced turns)' : 'Tokens in and out', tone: 'accent' }]} format={n => priced ? formatUsd(n) : formatTokenCount(n)}/></div>
    <div className="costs-tables">
      <Table title="By model" rows={report.byModel} empty="No turns in this period."/>
      <Table title="By agent" rows={report.byAgent} empty="No turns in this period."/>
      {!projectId && <Table title="By project" rows={report.byProject} empty="No turns in this period."/>}
    </div>
    {!projectId && <section className="costs-windows" aria-label="Provider limits">
      <h3 className="ws-group-title">Provider limits<span>{report.windows.length}</span></h3>
      {report.windows.length === 0 ? <p className="ws-board-empty">No provider here reports rate limits. ChatGPT sign-ins and Codex gateways do, after a run.</p>
        : <div className="costs-window-list">{report.windows.map(w => <div key={w.providerId} className="costs-window"><h4>{w.name}</h4><ProviderUsageMeters usage={w.usage ?? undefined} loaded/></div>)}</div>}
    </section>}
    {report.truncated && <p className="costs-note" role="status" data-truncated="true">The Ledger holds more than a report reads, so the oldest days are missing from these totals. Choose a shorter period for exact numbers.</p>}
    <p className="costs-note">Costs are estimates from the Ledger{report.ledgerSince ? `, which goes back to ${new Date(report.ledgerSince).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}. A turn on a model with no price is counted as unpriced; set your own price in Settings › Models.</p>
  </div>;
}
