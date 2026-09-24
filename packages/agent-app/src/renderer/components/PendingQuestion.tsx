import React, { useState } from 'react';
import type { PendingQuestionData, TimelineItem } from '../../shared/protocol';
import { respondQuestion } from '../store';
import { invoke } from '../bridge';
import './pending-question.css';
import { useQuestionHosted } from './ComposerQuestionPanel';

function questionData(item: TimelineItem): PendingQuestionData | null {
  const value = item.data;
  if (!value || value.method !== 'item/tool/requestUserInput' || !Array.isArray(value.questions)) return null;
  return value as unknown as PendingQuestionData;
}

function storedAnswers(item: TimelineItem): Record<string, string[]> {
  const answers = item.data && typeof item.data.answers === 'object' && item.data.answers !== null ? item.data.answers as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(answers).flatMap(([id, value]) => {
    const values = value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).answers) ? (value as Record<string, unknown>).answers : [];
    return [[id, (values as unknown[]).filter((answer): answer is string => typeof answer === 'string')]];
  }));
}
/** Readable end state; a question closed without answers told the provider it was cancelled. */
export function questionOutcome(item: TimelineItem): {label: string; detail?: string} {
  if (item.data?.expiredReason === 'restart' || item.status === 'unavailable') return {label: 'Expired · reopen not possible', detail: 'Muster restarted while this question was open. The provider stopped waiting for it; send your answer as a new message.'};
  switch (item.status) {
    case 'answered': return {label: 'Answer sent'};
    case 'dismissed': return {label: 'Dismissed', detail: 'The provider was told the question was declined.'};
    case 'expired': return {label: 'Expired', detail: 'No answer within 10 minutes; the provider was told the question was cancelled.'};
    case 'interrupted': return {label: 'Closed · the run stopped before an answer'};
    default: return {label: 'Closed'};
  }
}
function answerValues(answers: Record<string, string[]>, id: string): string[] {
  return Object.hasOwn(answers, id) ? answers[id]! : [];
}

export function PendingQuestion({ item }: { item: TimelineItem }): React.ReactElement {
  const data = questionData(item);
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => storedAnswers(item));
  const [error, setError] = useState('');
  const [responding, setResponding] = useState(false);
  const hosted = useQuestionHosted(item.chatId);
  if (!data) return <div className="pending-question" role="alert">This question could not be displayed.</div>;
  // CS-B11-1: while the composer's panel hosts this question it is answered there (1–9, typed answer), not here too.
  if (hosted && item.status === 'pending') return <section className="pending-question is-hosted" data-testid="pending-question-hosted" aria-label="Provider question">
    <h3>Input needed</h3>
    {data.questions.map(question => <p key={question.id}>{question.question}</p>)}
    <p className="pending-question-outcome"><span>Answer in the panel above the message box.</span></p>
  </section>;
  const pending = item.status === 'pending' && !responding;
  const submit = async () => {
    if (!pending || data.questions.some(question => answerValues(answers, question.id).length === 0)) return;
    setError(''); setResponding(true);
    const accepted = await respondQuestion(item.id, Object.fromEntries(data.questions.map(question => [question.id, { answers: answers[question.id] }])));
    if (!accepted) { setResponding(false); setError('The answer was not accepted. Your selections are retained.'); }
  };
  const dismiss = async () => {
    if (!pending) return;
    setError(''); setResponding(true);
    try { await invoke('question.dismiss', { id: item.id }); }
    catch (cause) { setResponding(false); setError(cause instanceof Error ? cause.message : 'The question could not be dismissed.'); }
  };
  const outcome = item.status === 'pending' ? null : questionOutcome(item);
  return <section className={`pending-question${item.status === 'pending' ? '' : ' is-settled'}`} aria-label="Provider question">
    <h3>Input needed</h3>
    {data.questions.map(question => <fieldset key={question.id} disabled={!pending}>
      <legend>{question.header}</legend>
      <p>{question.question}</p>
      {question.options.map(option => { const answer = option.value ?? option.label; const selected = answerValues(answers, question.id).includes(answer); return <label key={option.label} className="pending-question-option"><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}:${question.id}`} checked={selected} onChange={() => setAnswers(current => ({ ...current, [question.id]: question.multiSelect ? (selected ? answerValues(current, question.id).filter(value => value !== answer) : [...answerValues(current, question.id), answer]) : [answer] }))} /> <span>{option.label}{option.description && <small>{option.description}</small>}</span></label>; })}
      {question.allowCustomAnswer && <label className="pending-question-custom">Other answer<input type={question.isSecret ? 'password' : 'text'} autoComplete={question.isSecret ? 'off' : undefined} value={question.allowCustomAnswer ? (answerValues(answers, question.id).find(value => !question.options.some(option => (option.value ?? option.label) === value)) ?? '') : ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value ? [event.target.value] : answerValues(current, question.id).filter(value => question.options.some(option => (option.value ?? option.label) === value)) }))} placeholder={question.options.length ? 'Or type a custom response' : 'Type your answer'} /></label>}
    </fieldset>)}
    {pending && <div className="pending-question-actions"><button type="button" className="pending-question-submit" disabled={data.questions.some(question => answerValues(answers, question.id).length === 0)} onClick={() => void submit()}>Send answer</button>
      <button type="button" className="pending-question-dismiss" onClick={() => void dismiss()}>Dismiss</button></div>}
    {responding && item.status === 'pending' && <span className="pending-question-status" role="status">Sending…</span>}
    {outcome && <p className="pending-question-outcome" role="status"><strong>{outcome.label}</strong>{outcome.detail && <span>{outcome.detail}</span>}</p>}
    {error && <p className="pending-question-error" role="alert">{error}</p>}
  </section>;
}
