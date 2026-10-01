/**
 * Skill Studio helpers (G26): a skill drafted from a finished task, the prompt a skill test gets, and the starter templates.
 * Pure functions; the domain reads the task and runs the test.
 */
import type { SkillDraft, SkillTemplate } from '../../shared/domains/insight-protocol.ts';

const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };
const clipBlock = (s: string, n: number) => { const t = s.trim(); return t.length > n ? `${t.slice(0, n).trimEnd()}\n…` : t; };

export interface TaskSkillSource {
  title: string; acceptance: string; state: string; owner: string | null;
  plan: string | null; documents: { key: string; text: string }[];
  finalReply: string; tools: string[]; messages: number;
}

/** A SKILL.md body from what the task shows: the goal, the plan it followed, what counted as done, and how the run ended. */
export function draftSkillFromTask(src: TaskSkillSource): SkillDraft {
  const title = clip(src.title, 80);
  const lines: string[] = [`# ${title}`, '', '## Goal', src.acceptance.trim() ? `${title}.\n\n${clipBlock(src.acceptance, 1200)}` : `${title}.`];
  if (src.plan) lines.push('', '## Plan to follow', clipBlock(src.plan, 2500));
  const checks = src.acceptance.split('\n').map(l => l.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(l => l.length > 3 && l.length < 200).slice(0, 8);
  if (checks.length > 1) lines.push('', '## Check before finishing', ...checks.map(c => `- ${c}`));
  const extras = src.documents.filter(d => d.key !== 'plan').slice(0, 3);
  if (extras.length) lines.push('', '## Notes kept with the task', ...extras.flatMap(d => [`### ${d.key}`, clipBlock(d.text, 800)]));
  if (src.finalReply.trim()) lines.push('', '## How the original run ended', '', `> ${clipBlock(src.finalReply, 900).replace(/\n/g, '\n> ')}`);
  if (src.tools.length) lines.push('', `Tools the original run used: ${src.tools.slice(0, 8).join(', ')}.`);
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return { name: title, description: `Use when asked to do work like “${clip(src.title, 120)}”.`, body: text };
}

/** What a test run is told: the skill's instructions, then the test input. Read-only: it describes what it would do and shows the result. */
export function skillTestPrompt(skill: string, body: string, input: string): string {
  return [
    `You are testing the skill “${skill}”. Follow its instructions exactly as an agent that has the skill would.`,
    'This is a test in a read-only chat: you may read files, but you cannot change anything. Where the skill would change something, say what you would change instead.',
    '', '--- Skill instructions ---', body.trim(), '--- End of skill instructions ---', '',
    'Test input:', input.trim(), '', 'Answer as the skill directs. Finish with one line starting “Test note:” saying where the instructions were unclear or missing, or “Test note: none”.',
  ].join('\n');
}

export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  { id: 'release-notes', name: 'Release notes', description: 'Use when asked to write release notes from a list of changes or merged pull requests.', body: '# Release notes\n\n1. Group the changes: Added, Changed, Fixed, Removed.\n2. Write each line for a user, not a developer: what they can now do, in one sentence.\n3. Lead with the change most users will notice.\n4. Link each line to its pull request or issue when a link is given.\n5. End with upgrade notes only if something needs the user to act.\n\nKeep it under one screen. Never invent a change that is not in the input.' },
  { id: 'code-review', name: 'Code review checklist', description: 'Use when asked to review a diff or pull request for correctness, risk and clarity.', body: '# Code review\n\n1. Read the whole diff before commenting.\n2. Check correctness first: edge cases, error paths, concurrency, data loss.\n3. Then risk: security, performance, anything hard to roll back.\n4. Then clarity: names, comments that explain why, dead code.\n5. For each finding, say the file and line, what is wrong, and a concrete fix.\n6. Separate must-fix from nice-to-have. End with a clear verdict: approve, or request changes.' },
  { id: 'bug-triage', name: 'Bug triage', description: 'Use when asked to triage a bug report: reproduce, classify and suggest an owner.', body: '# Bug triage\n\n1. Restate the bug in one sentence, with expected and actual behaviour.\n2. Look for steps to reproduce; if missing, list exactly what to ask the reporter.\n3. Find the likely area of the code and the files involved.\n4. Classify: severity (blocks work, degrades, cosmetic) and who is affected.\n5. Suggest the next action: fix now, schedule, ask for more, or close as not a bug.\n\nDo not guess the cause as a fact; mark it as a hypothesis.' },
  { id: 'weekly-status', name: 'Weekly status', description: 'Use when asked to write a weekly status update for a project.', body: '# Weekly status\n\n1. One-line status: on track, at risk or blocked, and why.\n2. What shipped this week, as short bullets with links.\n3. What is in progress and who owns it.\n4. Risks and blockers, each with the decision or help needed.\n5. Next week: the two or three things that matter most.\n\nUse only facts from the input. Keep it under 200 words.' },
  { id: 'incident-summary', name: 'Incident summary', description: 'Use when asked to summarize an incident from logs, chat and timeline notes.', body: '# Incident summary\n\n1. Impact: who was affected, for how long, how badly.\n2. Timeline in UTC: detection, mitigation, resolution, one line each.\n3. Root cause, stated plainly; mark anything unproven as a hypothesis.\n4. What went well and what did not.\n5. Follow-ups: each with an owner and a date.\n\nBlameless wording: describe systems and decisions, not people.' },
];
