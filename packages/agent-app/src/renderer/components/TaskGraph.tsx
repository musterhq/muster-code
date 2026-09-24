import React from 'react';
import { layoutTaskGraph, type ProjectTaskView } from '../../shared/domains/projects-protocol';

const COL_W = 168, ROW_H = 40, PAD = 16, NODE_W = 148, NODE_H = 26;
const STATE_COLOR: Record<string, string> = { verified: 'var(--ok)', failed: 'var(--danger)', cancelled: 'var(--text-faint)', blocked: 'var(--danger)', 'needs-input': 'var(--warn)', running: 'var(--accent)' };

/** A simple layered DAG: columns by dependency depth, rows by priority/creation order, SVG edges between them. */
export function TaskGraph({ tasks, highlightId, onSelect }: { tasks: readonly ProjectTaskView[]; highlightId?: string | null; onSelect: (id: string) => void }) {
  if (tasks.length < 2) return null;
  const { nodes, edges, cols, rows } = layoutTaskGraph(tasks);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const pos = new Map(nodes.map(n => [n.id, { x: PAD + n.col * COL_W, y: PAD + n.row * ROW_H }]));
  const width = PAD * 2 + Math.max(1, cols) * COL_W - (COL_W - NODE_W), height = PAD * 2 + Math.max(1, rows) * ROW_H - (ROW_H - NODE_H);
  return <div className="task-graph" role="group" aria-label="Task dependency graph">
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Task dependencies, laid out by depth">
      <g className="task-graph-edges">
        {edges.map(e => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, mx = (x1 + x2) / 2;
          return <path key={`${e.from}:${e.to}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="var(--hairline)" strokeWidth={1.5}/>;
        })}
      </g>
      <g className="task-graph-nodes">
        {nodes.map(n => {
          const t = byId.get(n.id), p = pos.get(n.id)!;
          if (!t) return null;
          const done = t.state === 'verified';
          return <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`task-graph-node${n.id === highlightId ? ' is-highlighted' : ''}`}
            tabIndex={0} role="button" aria-label={`${t.title}, ${t.state}`} onClick={() => onSelect(n.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id); } }}>
            <rect width={NODE_W} height={NODE_H} rx={6} fill="var(--bg-raised)" stroke={STATE_COLOR[t.state] ?? 'var(--hairline)'} strokeOpacity={done ? 0.9 : 0.6} strokeWidth={done ? 1.5 : 1}/>
            <circle cx={11} cy={NODE_H / 2} r={3.5} fill={STATE_COLOR[t.state] ?? 'var(--text-faint)'}/>
            <text x={20} y={NODE_H / 2 + 4} fontSize={11} fill="var(--text)" clipPath={`url(#tg-clip-${n.id})`}>{t.title.length > 20 ? `${t.title.slice(0, 19)}…` : t.title}</text>
            <clipPath id={`tg-clip-${n.id}`}><rect width={NODE_W - 22} height={NODE_H}/></clipPath>
          </g>;
        })}
      </g>
    </svg>
  </div>;
}
