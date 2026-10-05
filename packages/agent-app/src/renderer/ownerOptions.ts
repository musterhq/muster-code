/**
 * The owner / assignee choices of a server task, as one list for every picker (New task "Owner", the properties "Assignee", the composer "Assign to"):
 * No owner, then "Me" pinned at the top, then People (alphabetical), then Agents. A person is assigned with `user:<id>` (the server's assigneeUserId, which
 * clears the agent); an agent with its id. Pure functions, so the pickers and their tests share them.
 */
import type { WorkspaceAgent, WorkspacePerson } from '../shared/domains/paperclip-protocol';

export type OwnerGroup = 'none' | 'me' | 'people' | 'agents';
export interface OwnerOption { value: string; label: string; hint: string | null; group: OwnerGroup }
export const OWNER_GROUP_LABEL: Record<OwnerGroup, string> = { none: '', me: 'Me', people: 'People', agents: 'Agents' };

/** "Name · Title", but only when the title adds something: an agent whose title is its name shows the name once. */
export function agentLabel(name: string, title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t && t.toLowerCase() !== name.trim().toLowerCase() ? `${name} · ${t}` : name;
}

export function ownerOptions(input: { agents: readonly WorkspaceAgent[]; people: readonly WorkspacePerson[]; noneLabel?: string | null; selected?: string | null }): OwnerOption[] {
  const out: OwnerOption[] = [];
  if (input.noneLabel !== null) out.push({ value: '', label: input.noneLabel ?? 'No owner', hint: null, group: 'none' });
  const me = input.people.find(p => p.me);
  if (me) out.push({ value: `user:${me.id}`, label: 'Me', hint: me.name && me.name !== 'Me' ? me.name : null, group: 'me' });
  for (const p of [...input.people].filter(p => !p.me).sort((a, b) => a.name.localeCompare(b.name))) out.push({ value: `user:${p.id}`, label: p.name, hint: null, group: 'people' });
  const agents = input.agents.filter(a => a.status !== 'terminated' || a.id === input.selected).sort((a, b) => a.name.localeCompare(b.name));
  for (const a of agents) out.push({ value: a.id, label: agentLabel(a.name, a.title), hint: null, group: 'agents' });
  return out;
}
/** Type-to-filter: every word of the query must appear in the label (any case); "Me" and "No owner" always match an empty query. */
export function filterOwners(options: readonly OwnerOption[], query: string): OwnerOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? options.filter(o => o.group !== 'none' && words.every(w => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(w))) : [...options];
}

// --- @-mentions --------------------------------------------------------------------------------------------------------------------------
export interface Mentionable { id: string; name: string; kind?: 'agent' | 'user' }
/** The chip Paperclip's own composer writes (`[@Name](agent://id)` or `[@Name](user://id)`): it renders as a chip on the web and reaches that person's or agent's Inbox. */
export const mentionChip = (m: Mentionable): string => `[@${m.name.replace(/[\][]/g, '')}](${m.kind === 'user' ? 'user' : 'agent'}://${m.id})`;
/** People first when the query matches, then agents; prefix matches before word matches. */
export function mentionMatches(list: readonly Mentionable[], query: string, limit = 6): Mentionable[] {
  const q = query.toLowerCase();
  const rank = (m: Mentionable) => (m.name.toLowerCase().startsWith(q) ? 0 : m.name.toLowerCase().split(/\s+/).some(w => w.startsWith(q)) ? 1 : 9) * 2 + (m.kind === 'user' ? 0 : 1);
  return list.filter(m => rank(m) < 18).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, limit);
}
/** Turns the `@Name` the person typed into chips for a server comment. Longest names first, so "@Ann Lee" is not read as "@Ann". Text inside a link or code is left alone. */
export function chipMentions(body: string, list: readonly Mentionable[]): string {
  let out = body;
  for (const m of [...list].sort((a, b) => b.name.length - a.name.length)) {
    const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[\\s(])@${escaped}(?![\\p{L}\\p{N}_])(?![^\\[]*\\]\\()`, 'giu'), (_all, lead: string) => `${lead}${mentionChip(m)}`);
  }
  return out;
}
