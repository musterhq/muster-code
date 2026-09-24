import React, {useEffect, useState} from 'react';
import {Menu} from '@base-ui/react/menu';
import {Check, ChevronDown, GitBranch, History} from 'lucide-react';
import {REVIEW_REF_PATTERN, type ReviewBaseline} from '../../shared/domains/review-protocol';
import type {GitBranches} from '../../shared/domains/git-protocol';
import {invoke} from '../bridge';
import {baselineKey, baselineLabel, latestBaseline, timeLabel, useChatBaselines} from '../reviewState';
import {useStoreSelector} from '../useStore';
import {Tip} from './Tooltip';
import './review-baseline-menu.css';

/** Branches offered under "Branch or commit": the current one is skipped (it equals HEAD), recent ones come first. */
export function refBaselineOptions(branches: GitBranches | undefined, limit = 6): string[] {
  if (!branches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (name: string) => { if (!name || name === branches.current || seen.has(name)) return; seen.add(name); out.push(name); };
  for (const name of branches.recent) add(name);
  for (const name of ['main', 'master', 'develop']) if (branches.local.some(branch => branch.name === name)) add(name);
  for (const branch of branches.local) add(branch.name);
  return out.slice(0, limit);
}

/**
 * "Compare against" (DIF-05): what the Changes list and the Diff tab measure from — the
 * active chat's last agent turn, an earlier turn, the unstaged or staged
 * side of the index, HEAD, or any branch, tag or commit ("vs main"). The
 * trigger always names the baseline.
 */
export function ReviewBaselineMenu({folderId, value, onChange}: {folderId: string; value: ReviewBaseline; onChange: (baseline: ReviewBaseline) => void}): React.ReactElement {
  const chatId = useStoreSelector(state => state.activeChatId ?? undefined);
  const chatStatus = useStoreSelector(state => state.snapshot?.chats.find(chat => chat.id === state.activeChatId)?.status);
  const turns = useChatBaselines(chatId, chatStatus).filter(turn => !turn.folderId || turn.folderId === folderId);
  const last = latestBaseline(turns, folderId);
  const lastEntry = turns.at(-1);
  const earlier = turns.filter(turn => turn.treeSha && turn.runId !== last?.runId);
  const usable = turns.filter(turn => turn.treeSha);
  const label = baselineLabel(value, usable);
  const current = baselineKey(value);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranches>();
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState('');
  useEffect(() => {
    if (!open) return;
    let live = true;
    invoke('git.branches', {folderId}).then(value => { if (live && value) setBranches(value); }, () => { if (live) setBranches(undefined); });
    return () => { live = false; };
  }, [open, folderId]);
  const refs = refBaselineOptions(branches);
  const chosenRef = typeof value !== 'string' && 'ref' in value ? value.ref : undefined;
  const pick = (key: string) => {
    if (key === 'head' || key === 'staged' || key === 'unstaged') onChange(key);
    else if (key.startsWith('run:')) onChange({runId: key.slice(4)});
    else if (key.startsWith('ref:')) onChange({ref: key.slice(4)});
  };
  const submitCustom = () => {
    const ref = custom.trim();
    if (!REVIEW_REF_PATTERN.test(ref)) { setCustomError('Enter a branch, tag or commit.'); return; }
    setCustomError(''); setCustom(''); onChange({ref}); setOpen(false);
  };
  const item = (key: string, text: React.ReactNode, detail?: string, disabled = false) => <Menu.RadioItem key={key} value={key} disabled={disabled} title={detail} className="review-baseline-item">
    <span className="review-baseline-check">{current === key && <Check size={13}/>}</span><span>{text}</span>
  </Menu.RadioItem>;
  return <Menu.Root open={open} onOpenChange={setOpen}>
    <Tip label="What these changes are measured from: the last commit, the staged files, an agent turn, or any branch or commit">
      <Menu.Trigger className="review-baseline-trigger" aria-label={`Compare against: ${label}`}>
        <History size={12} aria-hidden="true"/><span className="review-baseline-prefix">Compare against</span><span className="review-baseline-value">{label}</span><ChevronDown size={12} aria-hidden="true"/>
      </Menu.Trigger>
    </Tip>
    <Menu.Portal><Menu.Positioner side="bottom" align="start" sideOffset={4} className="review-baseline-positioner"><Menu.Popup className="ui-menu review-baseline-menu">
      <Menu.RadioGroup value={current} onValueChange={value => pick(String(value))}>
        <Menu.Group>
          <Menu.GroupLabel className="review-baseline-group">Agent turns</Menu.GroupLabel>
          {last ? item(`run:${last.runId}`, 'Last agent turn', `Changes since the snapshot taken ${timeLabel(last.at)}`)
            : item('run:none', 'Last agent turn', lastEntry?.reason ?? (chatId ? 'No agent turn has run in this folder from this chat yet.' : 'Open a chat to review its turns.'), true)}
          {earlier.slice(-8).reverse().map(turn => item(`run:${turn.runId}`, <>Since turn {usable.indexOf(turn) + 1} <span className="review-baseline-time">{timeLabel(turn.at)}</span></>, `Everything changed since the snapshot taken ${timeLabel(turn.at)}`))}
          {!last && lastEntry?.reason && <p className="review-baseline-reason">{lastEntry.reason}</p>}
        </Menu.Group>
        <Menu.Separator className="review-baseline-separator"/>
        <Menu.Group>
          <Menu.GroupLabel className="review-baseline-group">Your working folder</Menu.GroupLabel>
          {item('head', 'Last commit (all uncommitted changes)', 'Everything not yet committed, staged or not')}
          {item('staged', 'Staged changes only', 'What the next commit will contain')}
          {item('unstaged', 'Unstaged changes only', 'Edits not yet staged for the next commit')}
        </Menu.Group>
        <Menu.Separator className="review-baseline-separator"/>
        <Menu.Group aria-label="Branch or commit">
          <Menu.GroupLabel className="review-baseline-group">Branch or commit</Menu.GroupLabel>
          {chosenRef && !refs.includes(chosenRef) && item(`ref:${chosenRef}`, <><GitBranch size={12} aria-hidden="true"/> {chosenRef}</>, `Working tree against ${chosenRef}`)}
          {refs.map(name => item(`ref:${name}`, <><GitBranch size={12} aria-hidden="true"/> {name}</>, `Working tree against ${name}`))}
          {open && !branches && <p className="review-baseline-reason">Reading branches…</p>}
        </Menu.Group>
      </Menu.RadioGroup>
      <form className="review-baseline-ref" onSubmit={event => { event.preventDefault(); submitCustom(); }} onKeyDown={event => event.stopPropagation()}>
        <input type="text" value={custom} placeholder="Branch, tag or commit…" aria-label="Compare against a branch, tag or commit" spellCheck={false} autoComplete="off" maxLength={256}
          onChange={event => { setCustom(event.target.value); if (customError) setCustomError(''); }}/>
        <button type="submit" disabled={!custom.trim()}>Compare</button>
        {customError && <span className="review-baseline-ref-error" role="alert">{customError}</span>}
      </form>
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}
