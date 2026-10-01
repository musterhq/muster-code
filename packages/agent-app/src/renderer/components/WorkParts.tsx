/** Small shared parts of the work layer (Wave 2): label chips, pull request chips, star and hide buttons, date helpers. */
import { Star } from 'lucide-react';
import React from 'react';
import type { TaskLabel, TaskPrSummary } from '../../shared/domains/work-protocol';
import { Tip } from './Tooltip';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './work.css';

export function LabelChip({ label }: { label: Pick<TaskLabel, 'name' | 'color'> }): React.ReactElement {
  return <span className="ws-chip work-label" data-tone={label.color === 'faint' ? undefined : label.color === 'violet' ? 'violet' : label.color} data-color={label.color} title={`Label: ${label.name}`}>{label.name}</span>;
}
/** Up to `max` chips, then "+n". */
export function LabelChips({ labels, max = 3 }: { labels: readonly TaskLabel[] | undefined; max?: number }): React.ReactElement | null {
  if (!labels?.length) return null;
  return <span className="work-labels">{labels.slice(0, max).map(l => <LabelChip key={l.id} label={l}/>)}{labels.length > max && <span className="ws-chip" title={labels.slice(max).map(l => l.name).join(', ')}>+{labels.length - max}</span>}</span>;
}
/** A pull request chip: failing checks are red, open is blue, merged is green. */
export function PrChip({ pr }: { pr: TaskPrSummary | null | undefined }): React.ReactElement | null {
  if (!pr?.total) return null;
  const tone = pr.failing ? 'danger' : pr.pending ? 'warn' : pr.open ? 'accent' : pr.merged ? 'ok' : undefined;
  const text = pr.failing ? 'PR failing' : pr.pending ? 'PR running' : pr.open ? 'PR open' : pr.merged === pr.total ? 'PR merged' : 'PR closed';
  return <span className="ws-chip work-pr" data-tone={tone} title={`${pr.total} linked pull request${pr.total === 1 ? '' : 's'}: ${pr.open} open, ${pr.merged} merged${pr.failing ? `, ${pr.failing} with failing checks` : ''}`}>{text}{pr.total > 1 ? ` · ${pr.total}` : ''}</span>;
}
export function StarButton({ starred, label, onToggle }: { starred: boolean; label: string; onToggle: () => void }): React.ReactElement {
  return <Tip label={starred ? `Unstar ${label}` : `Star ${label}`}><button type="button" className="icon-button work-star" aria-pressed={starred} aria-label={starred ? `Unstar ${label}` : `Star ${label}`} onClick={e => { e.stopPropagation(); onToggle(); }}><Star size={14} fill={starred ? 'currentColor' : 'none'}/></button></Tip>;
}
export const dayLabel = (date: string): string => { const [y, m, d] = date.split('-').map(Number); return new Date(y!, m! - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
/** Days from today to a date (`YYYY-MM-DD`); negative when it has passed. */
export const daysUntil = (date: string, now = Date.now()): number => { const [y, m, d] = date.split('-').map(Number); const a = new Date(y!, m! - 1, d).getTime(), n = new Date(now); return Math.round((a - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 86_400_000); };
