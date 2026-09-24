import { CircleAlert, CircleCheck, CirclePause, CirclePlay, Goal, Maximize2, Minimize2, Pencil, Trash2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { GOAL_MAX_TEXT, GOAL_MAX_TOKEN_BUDGET, goalResumable, goalTokenProgress, type ChatGoal } from '../../shared/domains/goals-protocol';
import { invoke } from '../bridge';
import { runtimeMessage } from '../composerBridge';
import { ConfirmSheet } from './ConfirmSheet';
import { formatElapsed, goalElapsed, goalHeadline, goalStopNote } from './composerMenus';
import './goal-strip.css';
import {Tip} from './Tooltip';

/** Ticks once a second, only while the goal's clock runs. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
const FAILED = { 'goals.pause': 'Failed to update goal', 'goals.resume': 'Failed to update goal', 'goals.clear': 'Failed to clear goal' } as const;

/** Codex goal strip above the composer card: "Pursuing goal … 4h 11m 50s", with pause/resume, clear and edit. */
export function GoalStrip({ goal, onEdit }: { goal: ChatGoal; onEdit(): void }): React.ReactElement {
  const now = useNow(goal.status === 'active');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const headline = goalHeadline(goal), note = goalStopNote(goal), elapsed = formatElapsed(goalElapsed(goal, now)), tokens = goalTokenProgress(goal);
  const [budgetText, setBudgetText] = useState(goal.tokenBudget ? String(goal.tokenBudget) : '');
  useEffect(() => { setBudgetText(goal.tokenBudget ? String(goal.tokenBudget) : ''); }, [goal.tokenBudget]);
  const saveBudget = async () => {
    const value = budgetText.trim() ? Number(budgetText.trim().replace(/[,_\s]/g, '')) : null;
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > GOAL_MAX_TOKEN_BUDGET)) { setError('Enter a whole number of tokens, or leave it empty for no budget.'); return; }
    if (busy || value === (goal.tokenBudget ?? null)) return;
    setBusy(true); setError('');
    try { await invoke('goals.budget', { chatId: goal.chatId, tokenBudget: value }); } catch (cause) { setError(`Failed to update goal. ${runtimeMessage(cause)}`); } finally { setBusy(false); }
  };
  const act = async (command: keyof typeof FAILED) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await invoke(command, { chatId: goal.chatId }); } catch (cause) { setError(`${FAILED[command]}. ${runtimeMessage(cause)}`); } finally { setBusy(false); }
  };
  const Icon = goal.status === 'complete' ? CircleCheck : headline.tone === 'warn' ? CircleAlert : Goal;
  return <section data-testid="goal-strip" className={`goal-strip is-${headline.tone}${expanded ? ' is-expanded' : ''}`} aria-label="Chat goal" data-status={goal.status}>
    <div className="goal-strip-row">
      <Icon size={13} aria-hidden="true" className="goal-strip-icon" />
      <span className="goal-strip-label">{headline.label}</span>
      <span className="goal-strip-text" title={goal.text}>{goal.text}</span>
      {tokens && <span className="goal-strip-time goal-strip-tokens" aria-label="Tokens used" data-testid="goal-tokens">{tokens}</span>}
      <span className="goal-strip-time" aria-label={goal.status === 'complete' ? 'Time to achieve' : 'Time pursuing'}>{elapsed}</span>
      <span className="goal-strip-actions">
        <Tip label="Clear goal"><button type="button" aria-label="Clear goal" disabled={busy} onClick={() => void act('goals.clear')}><Trash2 size={13} /></button></Tip>
        {goal.status === 'active'
          ? <Tip label="Pause goal"><button type="button" aria-label="Pause goal" disabled={busy} onClick={() => void act('goals.pause')}><CirclePause size={13} /></button></Tip>
          : <Tip label={goalResumable(goal) ? 'Resume goal' : 'Pursue again'}><button type="button" aria-label="Resume goal" disabled={busy} onClick={() => void act('goals.resume')}><CirclePlay size={13} /></button></Tip>}
        <Tip label={expanded ? 'Collapse' : 'Show full goal'}><button type="button" aria-label={expanded ? 'Collapse goal' : 'Expand goal'} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button></Tip>
      </span>
    </div>
    {note && !expanded && <p className="goal-strip-note">{note}</p>}
    {expanded && <div className="goal-strip-details">
      <p>{goal.text}</p>
      {note && <p className="goal-strip-note">{note}</p>}
      <div className="goal-strip-meta">
        <span>{goal.status === 'complete' ? `Achieved in ${elapsed}` : `${elapsed} pursuing`}</span>
        {!goal.native && <span>{goal.turns === 1 ? '1 automatic turn' : `${goal.turns} automatic turns`}</span>}
        <label className="goal-strip-budget">Token budget
          <input aria-label="Token budget" inputMode="numeric" placeholder="No limit" value={budgetText} disabled={busy}
            onChange={event => setBudgetText(event.target.value)} onBlur={() => void saveBudget()}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveBudget(); } }} />
        </label>
        <button type="button" onClick={() => { setExpanded(false); onEdit(); }}><Pencil size={11} />Edit goal</button>
      </div>
    </div>}
    {error && <p className="goal-strip-error" role="alert">{error}</p>}
  </section>;
}

/** Goal editor in the strip slot. `edit` saves the objective in place; otherwise it sets a goal, asking before it replaces an unfinished one. */
export function GoalEditor({ chatId, initial, mode = 'set', replaces, onDone }: { chatId: string; initial: string; mode?: 'set' | 'edit'; replaces?: ChatGoal; onDone(saved: boolean): void }): React.ReactElement {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => { field.current?.focus(); field.current?.setSelectionRange(text.length, text.length); }); return () => cancelAnimationFrame(frame); }, []);
  const save = async (confirmed = false) => {
    const value = text.trim();
    if (busy || !value) return;
    if (mode === 'set' && replaces && replaces.status !== 'complete' && !confirmed) { setConfirm(true); return; }
    setConfirm(false); setBusy(true); setError('');
    try { await invoke(mode === 'edit' ? 'goals.edit' : 'goals.set', { chatId, text: value }); onDone(true); }
    catch (cause) { setError(`${mode === 'edit' ? 'Failed to save goal objective' : 'Failed to set goal'}. ${runtimeMessage(cause)}`); setBusy(false); }
  };
  return <form data-testid="goal-editor" className="goal-strip goal-editor" aria-label={mode === 'edit' ? 'Edit goal' : 'Set a goal'} onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="goal-strip-row">
      <Goal size={13} aria-hidden="true" className="goal-strip-icon" />
      <textarea ref={field} aria-label="Goal" rows={2} maxLength={GOAL_MAX_TEXT} placeholder="Describe your goal, define measurable outcomes for best results" value={text} disabled={busy}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void save(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(false); }
        }} />
    </div>
    <div className="goal-editor-footer">
      <span>{mode === 'edit' ? 'Edit goal · the clock keeps running' : 'Muster keeps working when the chat is idle until the goal is achieved'}</span>
      <button type="button" onClick={() => onDone(false)} disabled={busy}>Cancel</button>
      <button type="submit" className="is-primary" disabled={busy || !text.trim()}>{busy ? 'Saving…' : mode === 'edit' ? 'Save' : 'Set goal'}</button>
    </div>
    {error && <p className="goal-strip-error" role="alert">{error}</p>}
    <ConfirmSheet open={confirm} testId="goal-replace" title="Replace current goal?" description="This will keep the chat but replace the saved goal with your current composer text"
      onCancel={() => { setConfirm(false); field.current?.focus(); }}
      actions={[{ label: 'Cancel', run: () => { setConfirm(false); field.current?.focus(); } }, { label: 'Replace goal', primary: true, run: () => void save(true) }]} />
  </form>;
}
