/**
 * The Roster graph (#115, #128): a top-down org chart of agent cards with orthogonal reporting lines, zoom in / out / fit
 * and drag-to-pan, laid out once per data change (no animation loop, no timers). Muster additions: a "talking now" edge
 * between agents working on the same live thread (click it to open that conversation), each card's current work, model
 * and memory badge, and keyboard navigation (arrows move between cards, Enter opens the agent).
 */
import { Brain, Maximize2, Minus, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceAgent, WorkspaceSnapshot, WorkspaceTask } from '../../shared/domains/paperclip-protocol';
import { AGENT_STATE_LABEL, Monogram } from './HubParts';

const CARD_W = 232, CARD_H = 118, H_GAP = 20, V_GAP = 56, FOREST_GAP = 72, PAD = 40;
const RUNTIME: Record<string, string> = { claude_local: 'Claude Code', codex_local: 'Codex', opencode_local: 'OpenCode', gemini_local: 'Gemini CLI', cursor_local: 'Cursor', process: 'Process', http: 'HTTP', muster: 'Muster' };
export const runtimeLabel = (adapter: string | null) => adapter ? RUNTIME[adapter] ?? adapter.replace(/_/g, ' ') : '—';

interface Placed { agent: WorkspaceAgent; x: number; y: number; depth: number }
interface Talk { from: string; to: string; task: WorkspaceTask }

/** Tidy tree: every subtree gets the width of its widest level; parents sit over the middle of their children. */
export function layoutRoster(agents: readonly WorkspaceAgent[]): { placed: Placed[]; width: number; height: number; roots: string[] } {
  const ids = new Set(agents.map(a => a.id)), kids = new Map<string | null, WorkspaceAgent[]>();
  for (const a of agents) { const parent = a.reportsTo && ids.has(a.reportsTo) && a.reportsTo !== a.id ? a.reportsTo : null; kids.set(parent, [...(kids.get(parent) ?? []), a]); }
  for (const list of kids.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const width = new Map<string, number>(), seen = new Set<string>();
  const measure = (a: WorkspaceAgent): number => {
    if (seen.has(a.id)) return CARD_W;
    seen.add(a.id);
    const children = kids.get(a.id) ?? [];
    const w = Math.max(CARD_W, children.reduce((sum, c, i) => sum + measure(c) + (i ? H_GAP : 0), 0));
    width.set(a.id, w);
    return w;
  };
  const roots = (kids.get(null) ?? []).sort((a, b) => Number(a.source === 'paperclip') - Number(b.source === 'paperclip') || a.name.localeCompare(b.name));
  const placed: Placed[] = [], done = new Set<string>();
  let cursor = PAD, maxDepth = 0;
  const place = (a: WorkspaceAgent, left: number, depth: number) => {
    if (done.has(a.id)) return;
    done.add(a.id);
    const w = width.get(a.id) ?? CARD_W;
    placed.push({ agent: a, x: left + (w - CARD_W) / 2, y: PAD + depth * (CARD_H + V_GAP), depth });
    maxDepth = Math.max(maxDepth, depth);
    const children = kids.get(a.id) ?? [];
    const total = children.reduce((sum, c, i) => sum + (width.get(c.id) ?? CARD_W) + (i ? H_GAP : 0), 0);
    let x = left + (w - total) / 2;
    for (const c of children) { place(c, x, depth + 1); x += (width.get(c.id) ?? CARD_W) + H_GAP; }
  };
  for (const root of roots) { measure(root); place(root, cursor, 0); cursor += (width.get(root.id) ?? CARD_W) + FOREST_GAP; }
  return { placed, width: cursor - FOREST_GAP + PAD, height: PAD * 2 + (maxDepth + 1) * CARD_H + maxDepth * V_GAP, roots: roots.map(r => r.id) };
}

/** Who is talking to whom right now: the owner of a live task's parent (or its creator) and the agent working on it. */
export function talkingNow(snapshot: Pick<WorkspaceSnapshot, 'tasks' | 'agents'>): Talk[] {
  const byId = new Map(snapshot.tasks.map(t => [t.id, t])), names = new Map(snapshot.agents.map(a => [a.name, a.id]));
  const talks: Talk[] = [];
  for (const task of snapshot.tasks) {
    if (!task.live || !task.assigneeId) continue;
    const parent = task.parentId ? byId.get(task.parentId) : undefined;
    const from = parent?.assigneeId ?? (task.origin ? names.get(task.origin) : undefined);
    if (from && from !== task.assigneeId) talks.push({ from, to: task.assigneeId, task });
  }
  return talks;
}

export function RosterGraph({ snapshot, onOpenAgent, onOpenTask }: { snapshot: WorkspaceSnapshot; onOpenAgent: (id: string) => void; onOpenTask: (id: string) => void }): React.ReactElement {
  const layout = useMemo(() => layoutRoster(snapshot.agents), [snapshot.agents]);
  const talks = useMemo(() => talkingNow(snapshot), [snapshot.tasks, snapshot.agents]);
  const at = useMemo(() => new Map(layout.placed.map(p => [p.agent.id, p])), [layout]);
  const work = useMemo(() => { const m = new Map<string, WorkspaceTask>(); for (const t of snapshot.tasks) if (t.assigneeId && (t.live || !m.has(t.assigneeId)) && t.status !== 'done' && t.status !== 'cancelled') m.set(t.assigneeId, t); return m; }, [snapshot.tasks]);
  const memory = useMemo(() => new Map(snapshot.projects.map(p => [p.id, p.memory])), [snapshot.projects]);
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  /** Fit the whole chart (the Fit button), or on open: fit the width but never below a readable scale; pan for the rest. */
  const fit = useCallback((readable = false) => {
    const box = viewport.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    const whole = Math.min(1, (box.width - 24) / layout.width, (box.height - 24) / layout.height);
    const scale = readable ? Math.max(Math.min(1, (box.width - 24) / layout.width), 0.62) : whole;
    const x = layout.width * scale <= box.width ? (box.width - layout.width * scale) / 2 : 12;
    setView({ scale, x, y: readable ? 8 : Math.max(12, (box.height - layout.height * scale) / 2) });
  }, [layout.width, layout.height]);
  useLayoutEffect(() => { fit(true); }, [fit]);
  const zoom = (factor: number) => setView(v => {
    const box = viewport.current?.getBoundingClientRect(), cx = (box?.width ?? 0) / 2, cy = (box?.height ?? 0) / 2;
    const scale = Math.min(2, Math.max(0.25, v.scale * factor));
    return { scale, x: cx - (cx - v.x) * (scale / v.scale), y: cy - (cy - v.y) * (scale / v.scale) };
  });
  // Drag to pan: pointer events only, no animation frames.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => { if ((e.target as HTMLElement).closest('button,a')) return; drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const onPointerMove = (e: React.PointerEvent) => { const d = drag.current; if (d) setView(v => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y })); };
  const onPointerUp = () => { drag.current = null; };
  const onWheel = (e: React.WheelEvent) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); } else setView(v => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })); };
  // Arrow keys move to the nearest card in that direction.
  const cards = useRef(new Map<string, HTMLButtonElement | null>());
  const onKeyDown = (e: React.KeyboardEvent, from: Placed) => {
    const dir = e.key === 'ArrowLeft' ? [-1, 0] : e.key === 'ArrowRight' ? [1, 0] : e.key === 'ArrowUp' ? [0, -1] : e.key === 'ArrowDown' ? [0, 1] : null;
    if (!dir) return;
    e.preventDefault();
    let best: Placed | null = null, score = Infinity;
    for (const p of layout.placed) {
      const dx = p.x - from.x, dy = p.y - from.y;
      if (p === from || (dir[0] && Math.sign(dx) !== dir[0]) || (dir[1] && Math.sign(dy) !== dir[1])) continue;
      const s = dir[0] ? Math.abs(dx) + Math.abs(dy) * 3 : Math.abs(dy) + Math.abs(dx) * 0.5;
      if (s < score) { score = s; best = p; }
    }
    if (best) { cards.current.get(best.agent.id)?.focus({ preventScroll: true } as FocusOptions); }
  };
  useEffect(() => { const onResize = () => fit(true); window.addEventListener('resize', onResize); return () => window.removeEventListener('resize', onResize); }, [fit]);

  const edges: React.ReactNode[] = [];
  const byParent = new Map<string, Placed[]>();
  for (const p of layout.placed) if (p.agent.reportsTo && at.has(p.agent.reportsTo)) byParent.set(p.agent.reportsTo, [...(byParent.get(p.agent.reportsTo) ?? []), p]);
  for (const [parentId, children] of byParent) {
    const parent = at.get(parentId)!, px = parent.x + CARD_W / 2, py = parent.y + CARD_H, mid = py + V_GAP / 2;
    const xs = children.map(c => c.x + CARD_W / 2);
    edges.push(<path key={`t:${parentId}`} className="ws-roster-line" d={`M${px},${py}V${mid}M${Math.min(px, ...xs)},${mid}H${Math.max(px, ...xs)}${xs.map(x => `M${x},${mid}V${mid + V_GAP / 2}`).join('')}`}/>);
  }
  const talkEdges = talks.map(t => {
    const a = at.get(t.from), b = at.get(t.to);
    if (!a || !b) return null;
    const x1 = a.x + CARD_W / 2, y1 = a.y + CARD_H, x2 = b.x + CARD_W / 2, y2 = b.y;
    const midY = (y1 + y2) / 2;
    return { key: `${t.from}>${t.to}:${t.task.id}`, d: `M${x1},${y1}C${x1},${midY} ${x2},${midY} ${x2},${y2}`, cx: (x1 + x2) / 2, cy: midY, task: t.task, from: a.agent.name, to: b.agent.name };
  }).filter((e): e is NonNullable<typeof e> => Boolean(e));

  return <div className="ws-roster">
    <div className="ws-roster-controls" role="toolbar" aria-label="Zoom">
      <button type="button" className="icon-button" aria-label="Zoom in" onClick={() => zoom(1.2)}><Plus size={15}/></button>
      <button type="button" className="icon-button" aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}><Minus size={15}/></button>
      <button type="button" className="icon-button" aria-label="Fit to screen" onClick={() => fit()}><Maximize2 size={14}/></button>
    </div>
    <div ref={viewport} className="ws-roster-viewport" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel}>
      <div className="ws-roster-canvas" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg className="ws-roster-svg" width={layout.width} height={layout.height} aria-hidden="true">
          {edges}
          {talkEdges.map(e => <path key={e.key} className="ws-roster-talk" d={e.d}/>)}
        </svg>
        {talkEdges.map(e => <button key={`chip:${e.key}`} type="button" className="ws-roster-talk-chip" style={{ left: e.cx, top: e.cy }} title={`${e.from} → ${e.to} · ${e.task.key} ${e.task.title}`} aria-label={`Talking now: ${e.from} to ${e.to} on ${e.task.key}. Open the conversation`} onClick={() => onOpenTask(e.task.id)}>
          <span className="ws-live-dot" aria-hidden="true"/>{e.task.key}
        </button>)}
        {layout.placed.map(p => {
          const a = p.agent, task = work.get(a.id), mem = task?.projectId ? memory.get(task.projectId) : null;
          const hover = [task ? `${task.live ? 'Working on' : 'Next'}: ${task.key} ${task.title}` : 'No open work', a.model ? `Model: ${a.model}` : null, a.error ? `Error: ${a.error.replace(/_/g, ' ')}` : null].filter(Boolean).join('\n');
          return <button key={a.id} ref={el => { cards.current.set(a.id, el); }} type="button" className="ws-roster-card" data-status={a.status} data-source={a.source} style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
            title={hover} aria-label={`${a.name}, ${a.title ?? a.role}. ${AGENT_STATE_LABEL[a.status]}. ${hover}`} onClick={() => onOpenAgent(a.id)} onKeyDown={e => onKeyDown(e, p)}>
            <span className="ws-roster-avatar"><Monogram name={a.name} kind={a.role === 'board' ? 'user' : 'agent'}/><span className="ws-roster-dot" data-status={a.status} aria-hidden="true"/></span>
            <span className="ws-roster-body">
              <span className="ws-roster-name">{a.name}</span>
              <span className="ws-roster-title">{a.title ?? a.role}</span>
              <span className="ws-roster-runtime">{a.role === 'board' ? 'Owner' : `${runtimeLabel(a.adapter)}${a.model ? ` · ${a.model}` : ''}`}</span>
              {task ? <span className="ws-roster-work">{task.live && <span className="ws-live-dot" aria-hidden="true"/>}{task.key} · {task.title}</span>
                : <span className="ws-roster-cap">{a.capabilities ?? ''}</span>}
            </span>
            {mem && mem.count > 0 && <span className="ws-roster-memory" title={`${mem.count} memories in ${mem.label}`}><Brain size={11} aria-hidden="true"/>{mem.count}</span>}
          </button>;
        })}
      </div>
    </div>
  </div>;
}
