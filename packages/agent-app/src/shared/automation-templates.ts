/**
 * Automation variables ({{name}}) and the ready-made templates (G3, G20). Pure: the runtime renders and validates with
 * these, and the Automations screen shows the same templates.
 */
import { BUILTIN_VARIABLES, VARIABLE_NAME, VARIABLE_VALUE_MAX, type AutomationExt, type AutomationTemplate, type AutomationVariable } from './domains/automations-protocol.ts';

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g;
/** The placeholder names a text uses, once each. */
export const variablesIn = (text: string): string[] => [...new Set([...text.matchAll(PLACEHOLDER)].map(m => m[1]!.toLowerCase()))];

/** Built-in values for a firing: the local date and time and the automation's name. */
export function builtinValues(automation: string, at: Date, timeZone?: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  const p = (t: string) => parts.find(x => x.type === t)?.value ?? '';
  return { date: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour') === '24' ? '00' : p('hour')}:${p('minute')}`, automation };
}
export function renderTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => { const v = values[name.toLowerCase()]; return v === undefined ? whole : v; });
}
/** Declared variables with their values: provided, else default. `missing` lists required ones that have neither. */
export function resolveVariables(declared: readonly AutomationVariable[], provided: Readonly<Record<string, unknown>> | undefined, builtins: Readonly<Record<string, string>>): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = { ...builtins }, missing: string[] = [];
  for (const v of declared) {
    const given = provided?.[v.name];
    const text = typeof given === 'string' ? given : typeof given === 'number' || typeof given === 'boolean' ? String(given) : undefined;
    const use = text !== undefined && text.trim() !== '' ? text.slice(0, VARIABLE_VALUE_MAX) : v.default;
    if (use === undefined || use === '') { if (v.required) missing.push(v.label || v.name); values[v.name] = ''; } else values[v.name] = use;
  }
  return { values, missing };
}
/** A problem with the declared variables or the placeholders the prompt and title use, or null. */
export function checkVariables(texts: readonly string[], declared: readonly AutomationVariable[]): string | null {
  const seen = new Set<string>();
  for (const v of declared) {
    if (!VARIABLE_NAME.test(v.name)) return `“${v.name}” is not a valid variable name. Use lowercase letters, digits and underscores, starting with a letter.`;
    if ((BUILTIN_VARIABLES as readonly string[]).includes(v.name)) return `“${v.name}” is built in; pick another name.`;
    if (seen.has(v.name)) return `The variable “${v.name}” is declared twice.`;
    if ((v.default ?? '').length > VARIABLE_VALUE_MAX) return `The default of “${v.name}” is too long.`;
    seen.add(v.name);
  }
  if (declared.length > 12) return 'An automation takes up to 12 variables.';
  for (const t of texts) for (const name of variablesIn(t)) if (!seen.has(name) && !(BUILTIN_VARIABLES as readonly string[]).includes(name)) return `The text uses {{${name}}}, but no variable with that name is declared.`;
  return null;
}

const ext = (over: Partial<AutomationExt> = {}): AutomationExt => ({ variables: [], approval: false, activityGate: false, webhook: false, ...over });
const WEEKDAYS = [1, 2, 3, 4, 5];
/** Templates for Automations (G3). They create project tasks; the project and its agents are chosen when you use one. */
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'daily-standup', name: 'Daily standup', description: 'Every weekday each Roster agent reports what it did, what is next and what blocks it. One digest lands in a task for you to read.',
    prompt: 'Standup for {{date}}. Report in at most five lines: what you did since the last standup, what you will do next, and anything blocking you. Read the project as needed, but do not change any files.',
    schedule: { kind: 'daily', time: '09:30', days: WEEKDAYS }, target: { kind: 'task', projectId: '', start: true, mode: 'standup', titleTemplate: 'Daily standup {{date}}' }, ext: ext({ activityGate: true }),
  },
  {
    id: 'weekly-learnings', name: 'What the org learned', description: 'Each Friday an agent reviews the week’s finished work and writes what to keep, change and repeat, as a document on the task.',
    prompt: 'Review this week’s finished tasks, hand-offs and review notes in the project. Write a short note: what we learned, what to change, what to repeat. Save it as the “learnings” document on this task with a block like:\n```muster-doc\n{"key":"learnings","text":"…your note in Markdown…","note":"Week of {{date}}"}\n```',
    schedule: { kind: 'daily', time: '16:00', days: [5] }, target: { kind: 'task', projectId: '', start: true, mode: 'task', titleTemplate: 'What we learned · week of {{date}}' }, ext: ext({ activityGate: true }),
  },
  {
    id: 'ci-health', name: 'CI health check', description: 'Each morning an agent checks the repository’s CI: failing checks on open pull requests and on the default branch, with a suggested next step for each.',
    prompt: 'Check CI for this project’s repository. List failing or stuck checks on open pull requests and on the default branch, each with a link and one suggested next step. If everything passes, say so in one line.',
    schedule: { kind: 'daily', time: '08:30', days: WEEKDAYS }, target: { kind: 'task', projectId: '', start: true, mode: 'task', titleTemplate: 'CI health · {{date}}' }, ext: ext({ activityGate: true }),
  },
  {
    id: 'project-digest', name: 'Project digest', description: 'Each Monday an agent writes what moved, what is blocked and what is next, and saves it as the “digest” document.',
    prompt: 'Write a digest of this project for {{date}}: what moved, what is blocked or at risk, and what is next. Save it as the “digest” document on this task with a block like:\n```muster-doc\n{"key":"digest","text":"…your digest in Markdown…","note":"{{date}}"}\n```',
    schedule: { kind: 'daily', time: '09:00', days: [1] }, target: { kind: 'task', projectId: '', start: true, mode: 'task', titleTemplate: 'Project digest · {{date}}' }, ext: ext({ activityGate: true }),
  },
];
