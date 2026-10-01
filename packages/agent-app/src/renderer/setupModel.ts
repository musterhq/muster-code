/** Project setup (C20, G31): the starter agents, and what the wizard still has to do for a project. Pure so it is unit tested. */
export interface AgentTemplate { id: string; label: string; name: string; title: string; instructions: string }
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  { id: 'chief', label: 'Chief of staff', name: 'Chief of staff', title: 'Chief of staff', instructions: 'You are the chief of staff for this project. Turn the goal into small tasks, keep the plan current, hand work to the right agent, and tell the owner what changed and what needs a decision.\n\nAsk the owner before anything costly, irreversible or outside the goal. Write short status notes in the task thread.' },
  { id: 'engineer', label: 'Engineer', name: 'Engineer', title: 'Software engineer', instructions: 'You build and fix things in this project’s code. Read the task and the relevant files first, change as little as you need to, run the tests, and say exactly what you ran and what happened.\n\nIf a task is unclear, ask in the thread instead of guessing.' },
  { id: 'researcher', label: 'Researcher', name: 'Researcher', title: 'Researcher', instructions: 'You find out what is true and write it down. Cite where each fact came from, separate what you verified from what you assume, and end with a short recommendation.\n\nKeep notes in a task document so the team can reuse them.' },
  { id: 'reviewer', label: 'Reviewer', name: 'Reviewer', title: 'Reviewer', instructions: 'You review finished work against its acceptance line. Check correctness first, then risk, then clarity. Name the file and line for each finding, and finish with a clear verdict: approve, or request changes with what must change.' },
];

export type SetupStep = 'mission' | 'team' | 'first' | 'launch';
export const SETUP_STEPS: readonly { id: SetupStep; label: string }[] = [{ id: 'mission', label: 'Mission' }, { id: 'team', label: 'Team' }, { id: 'first', label: 'First task' }, { id: 'launch', label: 'Launch' }];

/** A project nothing has been set up in yet: no tasks and no agent of its own. The Dashboard then offers the wizard. */
export const needsSetup = (p: { tasks: number; agents: number }): boolean => p.tasks === 0 && p.agents === 0;

export interface SetupSummary { goal: boolean; agents: string[]; task: string | null; interview: boolean }
export function launchLines(s: SetupSummary): string[] {
  const out: string[] = [];
  out.push(s.goal ? 'The mission is written; every chat and task run in this project can see it.' : 'No mission yet. Add one any time in Settings › General.');
  out.push(s.agents.length ? `${s.agents.length === 1 ? 'Agent' : 'Agents'} on the Roster: ${s.agents.join(', ')}.` : 'No agent yet. Tasks you own run by you; add an agent on the Roster tab to delegate.');
  if (s.task) out.push(`First task: ${s.task}.`);
  if (s.interview) out.push('The interview is open in the coordinator chat. Its plan arrives as a proposal in Settings › General › Coordinator.');
  return out;
}

import type { CoordinatorOp } from '../shared/domains/projects-protocol';
const clip = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? `${f.slice(0, n - 1)}…` : f; };
/** One line per proposed change, so a plan can be read before it is applied. */
export function describeOp(op: CoordinatorOp): string {
  switch (op.op) {
    case 'goal': return `Mission: “${clip(op.text, 140)}”`;
    case 'create': return `Add task “${clip(op.title, 100)}”${op.owner === 'user' ? ' (yours)' : ''}`;
    case 'update': return `Change task ${clip(op.id, 12)}${op.title ? ` to “${clip(op.title, 80)}”` : ''}`;
    case 'status': return `Move task ${clip(op.id, 12)} to ${op.state}`;
    case 'decision': return `Record the decision “${clip(op.title, 100)}”`;
  }
}
