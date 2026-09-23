import React from 'react';
import {Check, CircleDashed, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, MinusCircle, Tag, TriangleAlert, X} from 'lucide-react';
import {
  CHECK_TONE_LABEL, PR_TONE_LABEL, REF_KIND_LABEL, REVIEW_TONE_LABEL, checkTone, gitFileStatus, gitRefKind, gitSyncLabel, gitSyncTone, prTone, reviewTone,
  type CheckTone, type GitFileStatus, type GitRefKind, type PrTone, type ReviewTone,
} from '../gitStatus';
import {Tip} from './Tooltip';
import './git-colors.css';

/**
 * The shared Git glyphs: status letter, +/- counts, ref chip, ahead/behind, PR/review/check state.
 * Each renders its tone as a class backed by a token in git-colors.css, so every surface agrees.
 */

/** M / A / U / D / R / C / I chip with the plain-language status on hover. */
export function GitStatusBadge({status, resolved, title}: {status?: string; resolved?: GitFileStatus; title?: string}): React.ReactElement {
  const value = resolved ?? gitFileStatus(status);
  const label = title ?? value.label;
  return <span className={`git-status git-tone-${value.tone}`} data-status={value.code} title={label} aria-label={label}>
    {value.tone === 'conflict' && <TriangleAlert size={9} strokeWidth={2.4} aria-hidden="true"/>}{value.code}
  </span>;
}

/** Green "+a" / red "−d"; a zero side is omitted unless both are zero and `showZero` asks for it. */
export function GitCounts({adds, dels, className = '', showZero = false}: {adds?: number | null; dels?: number | null; className?: string; showZero?: boolean}): React.ReactElement | null {
  const a = adds ?? 0, d = dels ?? 0;
  if (!a && !d && !showZero) return null;
  return <span className={`change-counts ${className}`.trim()} aria-label={`${a} ${a === 1 ? 'line' : 'lines'} added, ${d} removed`}>
    {(a > 0 || showZero) && <span className="change-adds git-add" aria-hidden="true">+{a.toLocaleString('en-US')}</span>}
    {(d > 0 || showZero) && <span className="change-dels git-del" aria-hidden="true">−{d.toLocaleString('en-US')}</span>}
  </span>;
}

/** A branch, remote branch, tag or HEAD, coloured by kind. */
export function GitRefChip({name, kind, current, local}: {name: string; kind?: GitRefKind; current?: string | null; local?: ReadonlySet<string>}): React.ReactElement {
  const resolved = kind ? {kind, label: name.startsWith('tag: ') ? name.slice(5) : name} : gitRefKind(name, {current, local});
  const title = `${REF_KIND_LABEL[resolved.kind]}: ${resolved.label}`;
  return <span className={`git-ref is-${resolved.kind}`} data-ref-kind={resolved.kind} title={title}>
    {resolved.kind === 'tag' ? <Tag size={9} aria-hidden="true"/> : resolved.kind === 'current' ? <GitBranch size={9} aria-hidden="true"/> : null}{resolved.label}
  </span>;
}

/** ↑ahead (green) ↓behind (amber); both at once is diverged (red). Nothing when in sync. */
export function GitSync({ahead = 0, behind = 0}: {ahead?: number; behind?: number}): React.ReactElement | null {
  const tone = gitSyncTone(ahead, behind);
  if (tone === 'synced') return null;
  const label = gitSyncLabel(ahead, behind);
  return <span className={`git-sync is-${tone}`} data-sync={tone} title={label} aria-label={label}>
    {ahead > 0 && <span className="git-sync-up" aria-hidden="true">↑{ahead}</span>}
    {behind > 0 && <span className="git-sync-down" aria-hidden="true">↓{behind}</span>}
  </span>;
}

const PR_ICON: Record<PrTone, typeof GitPullRequest> = {open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed};
/** GitHub-convention PR icon: open green, draft grey, merged purple, closed red. */
export function PrStateIcon({state, draft, size = 14, className = ''}: {state?: string; draft?: boolean; size?: number; className?: string}): React.ReactElement {
  const tone = prTone(state, draft);
  const Icon = PR_ICON[tone];
  return <Icon size={size} className={`git-state-icon pr-state is-${tone} ${className}`.trim()} data-pr-state={tone} aria-label={`${PR_TONE_LABEL[tone]} pull request`}/>;
}
export function PrStatePill({state, draft, small = false}: {state?: string; draft?: boolean; small?: boolean}): React.ReactElement {
  const tone = prTone(state, draft);
  const Icon = PR_ICON[tone];
  return <span className={`git-state-pill pr-state is-${tone}${small ? ' is-small' : ''}`} data-pr-state={tone}><Icon size={small ? 10 : 12} aria-hidden="true"/>{PR_TONE_LABEL[tone]}</span>;
}

export function ReviewStatePill({state}: {state?: string}): React.ReactElement {
  const tone: ReviewTone = reviewTone(state);
  return <span className={`git-state-pill is-small review-state is-${tone}`} data-review-state={tone}>{REVIEW_TONE_LABEL[tone]}</span>;
}

/** ✓ green, ✕ red, spinning amber while running, grey dash when skipped/neutral. */
export function CheckStateIcon({check, tone: forced, size = 14}: {check?: {status?: string; conclusion?: string | null}; tone?: CheckTone; size?: number}): React.ReactElement {
  const tone = forced ?? checkTone(check ?? {});
  const label = CHECK_TONE_LABEL[tone];
  const className = `git-state-icon ci-state is-${tone}`;
  if (tone === 'success') return <Check size={size} className={className} data-check={tone} aria-label={label}/>;
  if (tone === 'failure') return <X size={size} className={className} data-check={tone} aria-label={label}/>;
  if (tone === 'pending') return <span className={className} data-check={tone} role="img" aria-label={label} style={{display: 'inline-flex'}}><Loader2 size={size} className="git-spin" aria-hidden="true"/></span>;
  return <MinusCircle size={size} className={className} data-check={tone} aria-label={label}/>;
}
/** Queued (never started) reads as pending too, with a dashed ring rather than a spinner. */
export function QueuedIcon({size = 14}: {size?: number}): React.ReactElement {
  return <CircleDashed size={size} className="git-state-icon ci-state is-pending" aria-label="Queued"/>;
}

/** A small (i) that explains a Git term on hover. */
export function GitHint({label, children}: {label: React.ReactNode; children: React.ReactElement}): React.ReactElement {
  return <Tip label={label}>{children}</Tip>;
}
