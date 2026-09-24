import React from 'react';
import {INCREMENTAL_INPUT_NOTE, costLabel, formatTokenCount, formatUsd, type UsageReport} from '../../shared/model-catalog';
import {useUsageReport} from '../modelPolicy';
import './usage-cost.css';

const modelLabel = (model: string) => model.replace(/^[a-z]+\//, '');
const priceSource = (row: UsageReport['rows'][number]) => row.pricing ? row.pricing.source === 'user' ? 'Your price' : 'Catalog price' : 'No known price';

/** Tokens and estimated cost per model. Unknown prices show "—"; a gateway that reports only incremental input is called out. */
export function UsageTable({report, empty = 'No token usage reported yet.'}: {report: UsageReport; empty?: string}): React.ReactElement {
  if (!report.rows.length) return <p className="usage-empty">{empty}</p>;
  return <>
    <table className="usage-table">
      <thead><tr><th scope="col">Model</th><th scope="col" className="numeric">Input</th><th scope="col" className="numeric">Output</th><th scope="col" className="numeric">Est. cost</th></tr></thead>
      <tbody>{report.rows.map(row => <tr key={`${row.providerId}:${row.model}`}>
        <td title={`${row.providerId} · ${row.model} · ${row.totals.requests} ${row.totals.requests === 1 ? 'request' : 'requests'}`}>{modelLabel(row.model)}</td>
        <td className="numeric" title={`${row.totals.inputTokens.toLocaleString('en-US')} input tokens${row.totals.cachedInputTokens ? `, ${row.totals.cachedInputTokens.toLocaleString('en-US')} cached` : ''}`}>{formatTokenCount(row.totals.inputTokens)}</td>
        <td className="numeric" title={`${row.totals.outputTokens.toLocaleString('en-US')} output tokens${row.totals.reasoningOutputTokens ? `, ${row.totals.reasoningOutputTokens.toLocaleString('en-US')} reasoning` : ''}`}>{formatTokenCount(row.totals.outputTokens)}</td>
        <td className="numeric" title={priceSource(row)}>{formatUsd(row.costUsd)}</td>
      </tr>)}</tbody>
      {report.rows.length > 1 && <tfoot><tr><th scope="row">Total</th><td className="numeric">{formatTokenCount(report.totals.inputTokens)}</td><td className="numeric">{formatTokenCount(report.totals.outputTokens)}</td><td className="numeric">{costLabel(report)}</td></tr></tfoot>}
    </table>
    {report.costUsd === null && <p className="usage-note">No price is known for {report.rows.length === 1 ? 'this model' : 'these models'}, so cost shows “—”. Add a price in Settings › Models.</p>}
    {report.costUsd !== null && report.unpricedTokens > 0 && <p className="usage-note">{formatTokenCount(report.unpricedTokens)} tokens ran on models without a known price and are not in the estimate.</p>}
    {report.incrementalInput && <p className="usage-note usage-caveat">{INCREMENTAL_INPUT_NOTE}</p>}
  </>;
}

/** Cumulative usage and cost for one chat (shown under the context meter, which reports occupancy, not billing). */
export function ChatUsageSection({chatId}: {chatId: string}): React.ReactElement {
  const {report, error} = useUsageReport('chat', chatId);
  return <section className="usage-section" aria-label="Token usage and cost">
    <h3>Usage &amp; cost</h3>
    {error && !report ? <p className="usage-empty">Usage unavailable: {error}</p> : !report ? <p className="usage-empty">Loading…</p> : <UsageTable report={report} />}
  </section>;
}

/** Project-wide model cost with per-task lines (PRJ-14). */
export function ProjectCostSummary({projectId}: {projectId: string}): React.ReactElement {
  const {report, error} = useUsageReport('project', projectId);
  return <section className="usage-section usage-project" aria-label="Model cost">
    <h3>Model cost{report && <span className="usage-total">{costLabel(report)}</span>}</h3>
    {error && !report ? <p className="usage-empty">Cost unavailable: {error}</p> : !report ? <p className="usage-empty">Loading…</p> : <>
      <UsageTable report={report} empty="No chat in this Project has reported token usage yet." />
      {!!report.tasks?.length && <table className="usage-table usage-tasks">
        <thead><tr><th scope="col">Task</th><th scope="col" className="numeric">Tokens</th><th scope="col" className="numeric">Est. cost</th></tr></thead>
        <tbody>{report.tasks.map(task => <tr key={task.taskId}><td>{task.title}</td><td className="numeric">{formatTokenCount(task.totals.inputTokens + task.totals.outputTokens)}</td><td className="numeric">{costLabel(task)}</td></tr>)}</tbody>
      </table>}
    </>}
  </section>;
}

/** Inline cost for one Project task, from an already loaded Project report. */
export function TaskCostChip({report, taskId}: {report: UsageReport | undefined; taskId: string}): React.ReactElement | null {
  const task = report?.tasks?.find(entry => entry.taskId === taskId);
  if (!task) return null;
  return <span className="usage-task-chip" title={`${(task.totals.inputTokens + task.totals.outputTokens).toLocaleString('en-US')} tokens · estimated model cost`}>{costLabel(task)}</span>;
}
