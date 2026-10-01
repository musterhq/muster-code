/** The Roster's state tabs and ordering (C13, G35). Pure. */
import type { WorkspaceAgent } from '../shared/domains/paperclip-protocol.ts';

/** Roster state tabs (C13): All, Active, Paused, Error, Starred and Hidden. Hidden agents are folded away from the other tabs. */
export type RosterTab = 'all' | 'active' | 'paused' | 'error' | 'starred' | 'hidden';
export const ROSTER_TAB_LABEL: Record<RosterTab, string> = { all: 'All', active: 'Active', paused: 'Paused', error: 'Error', starred: 'Starred', hidden: 'Hidden' };
export function rosterTabs(agents: readonly WorkspaceAgent[]): Record<RosterTab, WorkspaceAgent[]> {
  const shown = agents.filter(a => !a.hidden);
  return {
    all: shown, active: shown.filter(a => a.status === 'running' || a.status === 'active' || a.status === 'idle'), paused: shown.filter(a => a.status === 'paused'), error: shown.filter(a => a.status === 'error'),
    starred: shown.filter(a => a.starred), hidden: agents.filter(a => a.hidden),
  };
}
/** Starred agents first, then working ones, then by name. */
export const sortRoster = (agents: readonly WorkspaceAgent[]): WorkspaceAgent[] => [...agents].sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || Number(b.status === 'running') - Number(a.status === 'running') || a.name.localeCompare(b.name));

