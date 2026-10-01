/**
 * The Reflection Coach (G25): what an agent's recent work shows, the prompt a read-only reader gets, and how its answer is
 * read back. Pure functions: the domain gathers the facts and stores the proposal. The coach only ever proposes a new
 * `AGENTS.md`; accepting it is a separate, explicit step.
 */
import type { ReflectionEvidence } from '../../shared/domains/insight-protocol.ts';

const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };

export interface ReflectionFacts {
  agent: string; project: string; goal: string; file: string; current: string; now: Date;
  turns: { at: string; outcome: string; tools: string[]; task: string | null }[];
  tasks: { key: string; title: string; state: string }[];
  needsWork: { task: string | null; reason: string; excerpt: string }[];
  changes: string[];
  helpful: number;
}

export function evidenceOf(f: ReflectionFacts): ReflectionEvidence {
  return { turns: f.turns.length, failed: f.turns.filter(t => t.outcome === 'failed').length, needsWork: f.needsWork.length, changesRequested: f.changes.length, tasks: f.tasks.length };
}

/** Enough signal to say something useful: a few turns, or any explicit feedback. */
export const hasSignal = (f: ReflectionFacts, minTurns: number): boolean => f.turns.length >= minTurns || f.needsWork.length > 0 || f.changes.length > 0;

export function reflectionPrompt(f: ReflectionFacts): string {
  const lines = [
    `You are the Reflection Coach for the project “${f.project}”.${f.goal ? ` Its goal: ${clip(f.goal, 300)}` : ''}`,
    `Read the recent record of the agent “${f.agent}” and decide whether its standing instructions (the file ${f.file}) should change. Today is ${f.now.toISOString().slice(0, 10)}.`,
    '', `Current ${f.file}:`, '<<<', f.current.trim() || '(empty)', '>>>',
    '', `Recent turns (${f.turns.length}, newest first):`,
    ...(f.turns.slice(0, 25).map(t => `- ${t.at.slice(0, 10)} ${t.outcome}${t.task ? ` · ${t.task}` : ''}${t.tools.length ? ` · tools: ${t.tools.slice(0, 5).join(', ')}` : ''}`)),
    ...(f.tasks.length ? ['', 'Tasks it owns:', ...f.tasks.slice(0, 20).map(t => `- ${t.key} [${t.state}] ${clip(t.title, 100)}`)] : []),
    ...(f.changes.length ? ['', 'Reviewers asked for changes:', ...f.changes.slice(0, 10).map(c => `- ${clip(c, 220)}`)] : []),
    ...(f.needsWork.length ? ['', 'Replies you marked “Needs work”:', ...f.needsWork.slice(0, 10).map(n => `- ${n.task ? `${n.task}: ` : ''}${clip(n.reason || n.excerpt, 220)}`)] : []),
    ...(f.helpful ? ['', `${f.helpful} ${f.helpful === 1 ? 'reply was' : 'replies were'} marked “Helpful”: keep what works.`] : []),
    '', 'Rules:',
    '- Propose a change only when the record shows a repeated or costly pattern. One failure is not a pattern.',
    '- Keep what already works. Change the least you can, and keep the file short and concrete.',
    '- Do not add secrets, personal data or anything the record does not support.',
    '- You may read files in the project. Do not change anything.',
    '', 'Answer with exactly one fenced block and nothing after it:',
    '```muster-reflection', '{"changed": true, "rationale": "two or three sentences: the pattern, and why this change helps", "text": "the full new contents of the file"}', '```',
    `If nothing should change, answer {"changed": false, "rationale": "why the instructions already fit"}.`,
  ];
  return lines.join('\n');
}

export interface ParsedReflection { changed: boolean; rationale: string; text: string }
/** The last muster-reflection block of a reply, validated. Throws a plain sentence when it cannot be used. */
export function parseReflection(reply: string, maxChars: number): ParsedReflection {
  const blocks = [...reply.matchAll(/```muster-reflection[^\n]*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1);
  if (!last) throw new Error('The coach did not answer with a proposal block.');
  let raw: unknown;
  try { raw = JSON.parse(last[1]!); } catch { throw new Error('The coach’s proposal could not be read.'); }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rationale = typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 2000) : '';
  if (o.changed === false) return { changed: false, rationale: rationale || 'The instructions already fit the record.', text: '' };
  if (o.changed !== true || typeof o.text !== 'string' || !o.text.trim()) throw new Error('The coach’s proposal had no new text.');
  if (o.text.length > maxChars) throw new Error('The coach’s proposal was too long to keep.');
  if (!rationale) throw new Error('The coach did not say why.');
  return { changed: true, rationale, text: o.text.replace(/\r\n/g, '\n').trimEnd() + '\n' };
}
