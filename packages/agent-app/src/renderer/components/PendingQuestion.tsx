import React, { useState } from 'react';
import type { PendingQuestionData, TimelineItem } from '../../shared/protocol';
import { respondQuestion } from '../store';
import './pending-question.css';

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
function answerValues(answers: Record<string, string[]>, id: string): string[] {
  return Object.hasOwn(answers, id) ? answers[id]! : [];
}

export function PendingQuestion({ item }: { item: TimelineItem }): React.ReactElement {
  const data = questionData(item);
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => storedAnswers(item));
  const [error, setError] = useState('');
  const [responding, setResponding] = useState(false);
  if (!data) return <div className="pending-question" role="alert">This question could not be displayed.</div>;
  const pending = item.status === 'pending' && !responding;
  const submit = async () => {
    if (!pending || data.questions.some(question => answerValues(answers, question.id).length === 0)) return;
    setError(''); setResponding(true);
    const accepted = await respondQuestion(item.id, Object.fromEntries(data.questions.map(question => [question.id, { answers: answers[question.id] }])));
    if (!accepted) { setResponding(false); setError('The answer was not accepted. Your selections are retained.'); }
  };
  return <section className="pending-question" aria-label="Provider question">
    <h3>Input needed</h3>
    {data.questions.map(question => <fieldset key={question.id} disabled={!pending}>
      <legend>{question.header}</legend>
      <p>{question.question}</p>
      {question.options.map(option => { const answer = option.value ?? option.label; const selected = answerValues(answers, question.id).includes(answer); return <label key={option.label} className="pending-question-option"><input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${item.id}:${question.id}`} checked={selected} onChange={() => setAnswers(current => ({ ...current, [question.id]: question.multiSelect ? (selected ? answerValues(current, question.id).filter(value => value !== answer) : [...answerValues(current, question.id), answer]) : [answer] }))} /> <span>{option.label}{option.description && <small>{option.description}</small>}</span></label>; })}
      {question.allowCustomAnswer && <label className="pending-question-custom">Other answer<input type={question.isSecret ? 'password' : 'text'} autoComplete={question.isSecret ? 'off' : undefined} value={question.allowCustomAnswer ? (answerValues(answers, question.id).find(value => !question.options.some(option => (option.value ?? option.label) === value)) ?? '') : ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value ? [event.target.value] : answerValues(current, question.id).filter(value => question.options.some(option => (option.value ?? option.label) === value)) }))} placeholder={question.options.length ? 'Or type a custom response' : 'Type your answer'} /></label>}
    </fieldset>)}
    {pending && <button type="button" className="pending-question-submit" disabled={data.questions.some(question => answerValues(answers, question.id).length === 0)} onClick={() => void submit()}>Send answer</button>}
    {responding && item.status === 'pending' && <span className="pending-question-status" role="status">Sending answer…</span>}
    {item.status !== 'pending' && <span className="pending-question-status" role="status">Answer {item.status === 'answered' ? 'sent' : 'closed'}.</span>}
    {error && <p className="pending-question-error" role="alert">{error}</p>}
  </section>;
}
