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
/**
 * What the transcript calls a subagent: its name, else its role, else the gist of its task,
 * else "Agent N". Raw thread ids are never shown as names (QA: "01a0c823-1…0a9 started working").
 */
export function agentDisplayName(agent: {name?: string; role?: string; prompt?: string}, ordinal?: number): string {
  const name = agent.name?.trim();
  if (name && !isIdLike(name)) return name;
  const role = agent.role?.trim();
  if (role && !isIdLike(role)) return titleCase(role);
  const gist = agent.prompt?.trim().split(/[\n.:;!?]/)[0]?.trim();
  if (gist) return gist.length > 40 ? `${gist.slice(0, 38).trimEnd()}…` : gist;
  return ordinal ? `Agent ${ordinal}` : 'Agent';
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
