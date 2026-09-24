import { Check, ChevronDown, X } from 'lucide-react';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PendingQuestion, PendingQuestionData, TimelineItem } from '../../shared/protocol';
import { invoke } from '../bridge';
import { respondQuestion } from '../store';
import { pickQuestionOption, questionAnswer, questionOptionValue } from './composerMenus';

/* Which chats answer questions in the composer (CS-B11-1). The timeline's own question card turns into a pointer
 * while a composer panel hosts it, so the same question is never answerable in two places at once. */
const hosts = new Map<string, number>();
const hostListeners = new Set<() => void>();
const hostChanged = () => { for (const listener of hostListeners) listener(); };
function claimHost(chatId: string): () => void {
  hosts.set(chatId, (hosts.get(chatId) ?? 0) + 1); hostChanged();
  return () => { const left = (hosts.get(chatId) ?? 1) - 1; if (left > 0) hosts.set(chatId, left); else hosts.delete(chatId); hostChanged(); };
}
const subscribeHosts = (listener: () => void) => { hostListeners.add(listener); return () => { hostListeners.delete(listener); }; };
/** True while this chat's composer shows the pending-question panel. */
export function useQuestionHosted(chatId: string): boolean {
  return useSyncExternalStore(subscribeHosts, () => hosts.has(chatId), () => false);
}

export interface QuestionFlow {
  item: TimelineItem; data: PendingQuestionData; question: PendingQuestion; index: number; total: number; last: boolean;
  answers: Record<string, string[]>; collapsed: boolean; responding: boolean; error: string;
  /** 1–9 (0-based `option`): single-select picks and auto-advances after 200 ms; multi-select toggles. */
  pick(option: number): void;
  /** Next (or Submit on the last question). `typed` is the composer text, the custom answer; returns whether it was used. */
  advance(typed: string): Promise<{ usedTyped: boolean }>;
  previous(): void;
  dismiss(): Promise<void>;
  setCollapsed(value: boolean): void;
}

/** State for the oldest pending question of a chat; null when nothing is waiting. */
export function useQuestionFlow(chatId: string, pending: { item: TimelineItem; data: PendingQuestionData } | null): QuestionFlow | null {
  const id = pending?.item.id ?? '';
  const [state, setState] = useState<{ id: string; index: number; answers: Record<string, string[]>; collapsed: boolean; responding: boolean; error: string }>({ id, index: 0, answers: {}, collapsed: false, responding: false, error: '' });
  const advanceTimer = useRef(0);
  const current = state.id === id ? state : { id, index: 0, answers: {}, collapsed: false, responding: false, error: '' };
  useEffect(() => { if (state.id !== id) setState(current); window.clearTimeout(advanceTimer.current); }, [id]);
  useEffect(() => { if (!pending) return; return claimHost(chatId); }, [chatId, Boolean(pending)]);
  useEffect(() => () => window.clearTimeout(advanceTimer.current), []);
  if (!pending) return null;
  const { item, data } = pending, total = data.questions.length;
  const index = Math.min(current.index, total - 1), question = data.questions[index]!, last = index === total - 1;
  const patch = (next: Partial<typeof current>) => setState(value => ({ ...(value.id === id ? value : current), ...next }));
  const submit = async (answers: Record<string, string[]>) => {
    const missing = data.questions.findIndex(entry => !(answers[entry.id]?.length));
    if (missing >= 0) { patch({ answers, index: missing, error: `Answer “${data.questions[missing]!.header || data.questions[missing]!.question}” first.` }); return; }
    patch({ answers, responding: true, error: '' });
    const accepted = await respondQuestion(item.id, Object.fromEntries(data.questions.map(entry => [entry.id, { answers: answers[entry.id]! }])));
    if (!accepted) patch({ responding: false, error: 'The answer was not accepted. Your selections are kept.' });
  };
  return {
    item, data, question, index, total, last, answers: current.answers, collapsed: current.collapsed, responding: current.responding, error: current.error,
    pick(option) {
      if (current.responding) return;
      const answers = pickQuestionOption(current.answers, question, option);
      if (!answers) return;
      patch({ answers, error: '' });
      window.clearTimeout(advanceTimer.current);
      if (!question.multiSelect && !last) advanceTimer.current = window.setTimeout(() => setState(value => value.id === id && value.index === index ? { ...value, index: index + 1 } : value), 200);
    },
    async advance(typed) {
      if (current.responding) return { usedTyped: false };
      const answer = questionAnswer(current.answers, question, typed), usedTyped = Boolean(typed.trim()) && answer.length === 1 && answer[0] === typed.trim();
      if (!answer.length) { patch({ error: question.options.length ? 'Pick an option (1–' + Math.min(9, question.options.length) + ') or type an answer.' : 'Type an answer first.' }); return { usedTyped: false }; }
      const answers = { ...current.answers, [question.id]: answer };
      window.clearTimeout(advanceTimer.current);
      if (!last) { patch({ answers, index: index + 1, error: '' }); return { usedTyped }; }
      await submit(answers);
      return { usedTyped };
    },
    previous() { if (index > 0) { window.clearTimeout(advanceTimer.current); patch({ index: index - 1, error: '' }); } },
    async dismiss() {
      patch({ responding: true, error: '' });
      try { await invoke('question.dismiss', { id: item.id }); }
      catch (cause) { patch({ responding: false, error: cause instanceof Error ? cause.message : 'The question could not be dismissed.' }); }
    },
    setCollapsed(collapsed) { patch({ collapsed }); },
  };
}

/** T3's pending-input panel in the goal-strip slot above the card: header, i/N, collapse, Dismiss, 1–9 options, Previous / Next·Submit. */
export function ComposerQuestionPanel({ flow, typed, onNext, onFocusInput }: { flow: QuestionFlow; typed: string; onNext(): void; onFocusInput(): void }): React.ReactElement {
  const { question, index, total, last, collapsed } = flow;
  const chosen = flow.answers[question.id] ?? [];
  const custom = typed.trim() && (question.allowCustomAnswer || !question.options.length);
  return <section className={`composer-question${collapsed ? ' is-collapsed' : ''}`} data-testid="composer-question" aria-label="Question from the agent">
    <header className="composer-question-head">
      <span className="composer-question-title">{question.header || 'Input needed'}</span>
      {total > 1 && <span className="composer-question-count" aria-label={`Question ${index + 1} of ${total}`}>{index + 1}/{total}</span>}
      <button type="button" className="composer-question-icon" aria-label={collapsed ? 'Expand question' : 'Collapse question'} aria-expanded={!collapsed} onClick={() => flow.setCollapsed(!collapsed)}><ChevronDown size={13} /></button>
      <button type="button" className="composer-question-dismiss" disabled={flow.responding} onClick={() => void flow.dismiss()}><X size={12} aria-hidden="true" />Dismiss</button>
    </header>
    {!collapsed && <>
      <p className="composer-question-text">{question.question}</p>
      {question.options.length > 0 && <div className="composer-question-options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
        {question.options.map((option, at) => { const selected = chosen.includes(questionOptionValue(option)) && !custom;
          return <button key={`${at}:${option.label}`} type="button" role={question.multiSelect ? 'checkbox' : 'radio'} aria-checked={selected} data-testid="composer-question-option"
            className={`composer-question-option${selected ? ' is-selected' : ''}`} disabled={flow.responding} onMouseDown={event => event.preventDefault()} onClick={() => { flow.pick(at); onFocusInput(); }}>
            <span className="composer-question-option-text"><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>
            {selected ? <Check size={13} className="composer-question-check" aria-hidden="true" /> : at < 9 ? <kbd>{at + 1}</kbd> : null}
          </button>; })}
      </div>}
      {custom && <p className="composer-question-note">Your typed answer will be sent for this question.</p>}
      <footer className="composer-question-actions">
        {flow.error && <span className="composer-question-error" role="alert">{flow.error}</span>}
        {index > 0 && <button type="button" className="composer-question-previous" disabled={flow.responding} onClick={() => flow.previous()}>Previous</button>}
        <button type="button" className="composer-question-next" data-testid="composer-question-next" disabled={flow.responding} onMouseDown={event => event.preventDefault()}
          onClick={onNext}>{flow.responding ? 'Sending…' : last ? 'Submit' : 'Next'}</button>
      </footer>
    </>}
  </section>;
}
