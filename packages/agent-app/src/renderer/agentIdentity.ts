import React from 'react';

const AGENT_HUES = [212, 12, 38, 152, 280, 330, 190];
/** Deterministic per-agent hue; matches SummaryCard's palette and hash exactly. */
export function agentHue(name: string): number { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AGENT_HUES[h % AGENT_HUES.length]; }

export type AgentGlyphState = 'working' | 'done' | 'failed' | 'idle';
/** Codex-style identity marks (burst, flower, clover, triangle, dot, hash, diamond), drawn on a 16-unit grid. */
const SHAPES: readonly ((fill: string) => React.ReactElement)[] = [
  fill => React.createElement('path', {fill, d:'M8 1.2l1.35 3.1 3.3-.95-.95 3.3L14.8 8l-3.1 1.35.95 3.3-3.3-.95L8 14.8l-1.35-3.1-3.3.95.95-3.3L1.2 8l3.1-1.35-.95-3.3 3.3.95z'}),
  fill => React.createElement('g', {fill}, ...[0, 60, 120].map(angle => React.createElement('ellipse', {key:angle, cx:8, cy:8, rx:2.3, ry:6.6, transform:`rotate(${angle} 8 8)`}))),
  fill => React.createElement('g', {fill}, ...[[8,4.4],[11.6,8],[8,11.6],[4.4,8]].map(([cx, cy]) => React.createElement('circle', {key:`${cx}:${cy}`, cx, cy, r:3.4}))),
  fill => React.createElement('path', {fill, d:'M8 2.2l6.2 11H1.8z', strokeLinejoin:'round', stroke:fill, strokeWidth:1.2}),
  fill => React.createElement('circle', {fill, cx:8, cy:8, r:5.6}),
  fill => React.createElement('path', {fill:'none', stroke:fill, strokeWidth:1.9, strokeLinecap:'round', d:'M6 2.5L5 13.5M11 2.5l-1 11M2.5 6h11.2M2.3 10h11.2'}),
  fill => React.createElement('path', {fill, d:'M8 1.6l6.4 6.4L8 14.4 1.6 8z'}),
];
function shapeIndex(name: string): number { let h = 7; for (const c of name) h = (h * 17 + c.charCodeAt(0)) >>> 0; return h % SHAPES.length; }
/** 16px identity mark in the agent's hue: never a letter or a digit from a thread id. Styles live in activity-group.css. */
export function AgentGlyph({name, state = 'idle'}: {name: string; state?: AgentGlyphState}): React.ReactElement {
  const fill = state === 'failed' ? 'var(--danger)' : 'hsl(var(--agent-hue) 64% 66%)';
  return React.createElement('span', {className:`agent-glyph is-${state}`, 'aria-hidden':true, style:{'--agent-hue':agentHue(name)} as React.CSSProperties},
    React.createElement('svg', {viewBox:'0 0 16 16', width:16, height:16, focusable:false}, SHAPES[shapeIndex(name)](fill)));
}

/** A provider thread id standing in for a name ("01a0c823-1…0a9", a UUID, a long hex run). */
export function isIdLike(value: string): boolean {
  const v = value.trim();
  return v.includes('…') || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) || /^(?:thread|agent|call|toolu)?[-_]?[0-9a-f-]{12,}$/i.test(v) || (/\d/.test(v) && /^[0-9a-z_-]{20,}$/i.test(v));
}
const titleCase = (value: string) => value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, c => c.toUpperCase());

// What a prompt opens with before it says what to do: where the agent runs ("In the repository at /tmp/x,"),
// who it is ("You are a reviewer."), and filler ("Please", "Task:"). None of it tells two agents apart (#651).
const PATH = String.raw`[\`'"]?(?:[~/]|[A-Za-z]:[\\/]|\.{1,2}[\\/])\S*?[\`'"]?`;
const LOCATION = new RegExp(String.raw`^(?:in|inside|within|under|from|at|working\s+(?:in|from|inside))\s+(?:the\s+)?(?:(?:git\s+)?(?:repo(?:sitory)?|project|workspace|folder|directory|dir|codebase|checkout|worktree)\s+)?(?:(?:at|in|located\s+at|called|named|rooted\s+at)\s+)?${PATH}(?:\s*\([^)]*\))?(?:[,:;.\-\u2013\u2014]\s+|\s+(?=[A-Za-z])|$)`, 'i');
const LEADERS = [
  LOCATION,
  /^(?:you\s+are|you're|act\s+as|you\s+will\s+act\s+as)\b[^\n.!?:]*[.!?:]\s+/i,
  /^(?:please|kindly)[,:]?\s+/i,
  /^(?:now|first|ok(?:ay)?)[,:]\s+/i,
  /^(?:(?:task|job|goal|assignment)\s*:|your\s+(?:task|job|goal)\s+is(?:\s+to)?[:,]?)\s*/i,
  /^(?:[-*\u2022]|\d+[.)])\s+/,
];
function skipLeaders(text: string): string {
  for (let pass = 0; pass < 6; pass++) {
    let hit = false;
    for (const leader of LEADERS) {
      const match = leader.exec(text);
      if (match && match[0].length < text.length) { text = text.slice(match[0].length); hit = true; }
    }
    if (!hit) break;
  }
  return text;
}
// "…, and report the number": what the agent should hand back is not what it was asked to do.
const WRAP_UP = /(?:,\s*(?:and\s+)?(?:then\s+)?|\s+(?:and|then)\s+(?:then\s+)?)(?:report|return|reply|respond|tell|write\s+back|summari[sz]e\s+(?:it|the\s+(?:result|findings)))\b.*$/i;
const TASK_LIMIT = 40;
const PATH_ONLY = new RegExp(`^${PATH}$`);
/** What the agent was asked to do: the first clause of its prompt after the location and boilerplate, short. A prompt that is only a location or a path says nothing. */
export function agentTaskName(prompt?: string): string | undefined {
  const text = skipLeaders(prompt?.trim() ?? '');
  if (!text || LOCATION.test(text) || PATH_ONLY.test(text)) return undefined;
  const clause = text.split(/\n|[.!?;](?=\s|$)|:(?=\s|$)/)[0]?.replace(WRAP_UP, '').trim().replace(/^[`'"]+|[`'",:;.\s]+$/g, '');
  if (!clause) return undefined;
  const task = clause[0].toUpperCase() + clause.slice(1);
  if (task.length <= TASK_LIMIT) return task;
  const head = task.slice(0, TASK_LIMIT - 2), space = head.lastIndexOf(' ');
  return `${(space >= 16 ? head.slice(0, space) : head).trimEnd()}…`;
}
const FILLER = /^(?:in|the|at|a|an|to|of|and|or|is|are|you|your|repository|repo|project|workspace|folder|directory|codebase|checkout|working|task|please|then|with|for|on|from|it|this|that|will|must|should|be)$/i;
/** The first few words of a prompt that say something: no paths, no filler. */
function distinctiveWords(prompt?: string): string {
  const words = (prompt ?? '').split(/\s+/).filter(word => word && !/[\\/]/.test(word)).flatMap(word => word.match(/^[A-Za-z][A-Za-z0-9'-]*/) ?? []).filter(word => !FILLER.test(word));
  return words.slice(0, 3).join(' ').toLowerCase();
}
/**
 * What the transcript calls a subagent: its name, else the task it was given (leading location and boilerplate
 * skipped), else its role, else "Agent N" plus the first distinctive words of the prompt. Raw thread ids are never
 * shown as names (QA: "01a0c823-1…0a9 started working").
 */
export function agentDisplayName(agent: {name?: string; role?: string; prompt?: string}, ordinal?: number): string {
  const name = agent.name?.trim();
  if (name && !isIdLike(name)) return name;
  const task = agentTaskName(agent.prompt);
  if (task) return task;
  const role = agent.role?.trim();
  if (role && !isIdLike(role)) return titleCase(role);
  const label = ordinal ? `Agent ${ordinal}` : 'Agent';
  const words = distinctiveWords(agent.prompt);
  return words ? `${label} · ${words}` : label;
}
/** Display names for every sub-agent of a chat, keyed by id and unique within it: a repeat gets " (2)", " (3)". */
export function agentDisplayNames(agents: readonly {id: string; name?: string; role?: string; prompt?: string}[]): Map<string, string> {
  const used = new Set<string>(), names = new Map<string, string>();
  agents.forEach((agent, index) => {
    const base = agentDisplayName(agent, index + 1);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    names.set(agent.id, name);
  });
  return names;
}

/** Semantic colour for composer tokens and context chips, shared with subagent identity (UX-X4). Grey = saturation 0. */
export type TokenKind = 'file' | 'folder' | 'chat' | 'skill' | 'plugin' | 'command' | 'subagent' | 'terminal' | 'quote' | 'selection' | 'memory' | 'review' | 'image' | 'mcp' | 'app';
export const TOKEN_COLORS: Record<Exclude<TokenKind, 'subagent'>, {h: number; s: number}> = {
  file:{h:212,s:70}, folder:{h:174,s:55}, chat:{h:220,s:0}, skill:{h:270,s:62}, plugin:{h:28,s:80}, command:{h:145,s:52},
  terminal:{h:152,s:45}, quote:{h:220,s:0}, selection:{h:212,s:55}, memory:{h:322,s:50}, review:{h:38,s:70}, image:{h:190,s:55},
  mcp:{h:190,s:50}, app:{h:28,s:60},
};
/** `--h`/`--s` custom properties for a token; subagents take their per-agent hue. A plugin's brand colour wins via `--chip`. */
export function tokenStyle(kind: TokenKind, name = '', brandColor?: string): React.CSSProperties {
  if (brandColor) return {'--chip': brandColor} as React.CSSProperties;
  const {h, s} = kind === 'subagent' ? {h: agentHue(name), s: 55} : TOKEN_COLORS[kind];
  return {'--h': h, '--s': `${s}%`} as React.CSSProperties;
}
