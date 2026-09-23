import { Brain, FileText, Folder, Image as ImageIcon, MessageSquareCode, MessagesSquare, Puzzle, Quote, Sparkles, SquareTerminal, TextSelect, X, type LucideIcon } from 'lucide-react';
import React, { useState } from 'react';
import type { PluginEntry, SkillEntry } from '../../shared/protocol';
import { tokenStyle, type TokenKind } from '../agentIdentity';
import { contextSourceLine, contextTypeLabel, type ContextChip, type ContextChipType } from '../composerContext';
import { PluginIcon } from './PluginIcon';
import type { ChipRange } from './composerMenus';

export const CONTEXT_ICONS: Record<ContextChipType, LucideIcon> = { file: FileText, folder: Folder, chat: MessagesSquare, terminal: SquareTerminal, quote: Quote, selection: TextSelect, plugin: Puzzle, skill: Sparkles, memory: Brain, review: MessageSquareCode, image: ImageIcon };
const TOKEN_LABELS: Record<ChipRange['chip']['kind'], string> = { file: 'File', folder: 'Folder', chat: 'Chat', skill: 'Skill', plugin: 'Plugin', command: 'Command', mcp: 'MCP server', app: 'App' };

/**
 * Highlight layer under a transparent-text textarea. It copies the textarea's metrics exactly
 * (same font, padding, wrapping) and only paints colour, background and an outset shadow,
 * so the caret and selection line up on every wrapped line.
 */
export function ChipMirror({ text, ranges, selected, plugins, mirror, hint }: { text: string; ranges: ChipRange[]; selected: { start: number; end: number }; plugins: readonly PluginEntry[]; mirror: React.RefObject<HTMLDivElement | null>; /** CS-B3-6: a plugin's default prompt, drawn after the chips while nothing else is typed. */ hint?: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach((range, index) => {
    if (range.start > at) parts.push(text.slice(at, range.start));
    const { chip } = range, token = text.slice(range.start, range.end);
    const plugin = chip.kind === 'plugin' ? plugins.find(entry => entry.id === chip.id) : undefined;
    parts.push(<span key={`${range.start}:${index}`} data-testid="token-chip" data-index={index} data-kind={chip.kind}
      className={`token-chip is-${chip.kind}${selected.start === range.start && selected.end === range.end ? ' is-selected' : ''}`}
      style={tokenStyle(chip.kind as TokenKind, chip.id, plugin?.brandColor)}>
      {chip.kind === 'plugin' ? <><span className="token-chip-lead">{token[0]}<PluginIcon icon={plugin?.icon} name={chip.label} seed={token.slice(1)} brandColor={plugin?.brandColor} size={14} /></span>{token.slice(1)}</> : token}
    </span>);
    at = range.end;
  });
  // The trailing zero-width space keeps a final newline's line box, as the textarea has.
  parts.push(text.slice(at));
  if (hint) parts.push(<span key="hint" className="composer-ghost-hint" data-testid="plugin-prompt-hint">{hint}</span>);
  parts.push('\u200b');
  return <div ref={mirror} className="composer-mirror" aria-hidden="true">{parts}</div>;
}

/** What a hovered token refers to: type, name and, for plugins, the skills and tools it brings. */
export function TokenCard({ range, plugins, skills, left, top }: { range: ChipRange; plugins: readonly PluginEntry[]; skills: readonly SkillEntry[]; left: number; top: number }): React.ReactElement {
  const { chip } = range;
  const plugin = chip.kind === 'plugin' ? plugins.find(entry => entry.id === chip.id) : undefined;
  const skill = chip.kind === 'skill' ? skills.find(entry => entry.id === chip.id) : undefined;
  const detail = plugin ? [plugin.shortDescription, plugin.skills.length ? `Skills: ${plugin.skills.join(', ')}` : '', plugin.mcpServers.length ? `MCP: ${plugin.mcpServers.map(server => server.name).join(', ')}` : '', plugin.apps.length ? `Apps: ${plugin.apps.map(app => app.name).join(', ')}` : ''].filter(Boolean)
    : skill ? [skill.shortDescription ?? '', skill.provenance].filter(Boolean)
      : chip.kind === 'command' ? ['Runs when chosen from the / menu'] : chip.kind === 'chat' ? [] : [chip.id];
  return <div className="token-card" role="tooltip" style={{ left, top, ...tokenStyle(chip.kind as TokenKind, chip.id, plugin?.brandColor) } as React.CSSProperties}>
    <span className="token-card-kind">{TOKEN_LABELS[chip.kind]}{plugin?.version ? ` · v${plugin.version}` : ''}</span>
    <strong>{chip.label}</strong>
    {detail.map(line => <small key={line}>{line}</small>)}
  </div>;
}

/** Typed context above the textarea: icon, label and provenance; click to preview the excerpt. */
export function ContextStrip({ chips, onRemove, onOpenSource }: { chips: readonly ContextChip[]; onRemove: (id: string) => void; onOpenSource: (chip: ContextChip) => void }): React.ReactElement | null {
  const [open, setOpen] = useState<string | null>(null);
  const visible = chips.filter(chip => chip.type !== 'image');
  if (!visible.length) return null;
  const expanded = visible.find(chip => chip.id === open);
  return <div className="composer-context" data-testid="composer-context">
    <ul className="composer-context-list" aria-label="Context">
      {visible.map(chip => {
        const Icon = CONTEXT_ICONS[chip.type], where = contextSourceLine(chip);
        return <li key={chip.id} data-testid="context-chip" data-type={chip.type} className={`context-chip is-${chip.type}${chip.stale ? ' is-stale' : ''}${open === chip.id ? ' is-open' : ''}`} style={tokenStyle(chip.type as TokenKind)}>
          <button type="button" className="context-chip-main" aria-expanded={chip.text ? open === chip.id : undefined} disabled={!chip.text}
            title={`${contextTypeLabel(chip.type)} · ${chip.label}${where ? ` · ${where}` : ''}${chip.stale ? ' · source changed since it was added' : ''}`} onClick={() => setOpen(current => current === chip.id ? null : chip.id)}>
            <span className="context-chip-icon"><Icon size={11} aria-hidden="true" /></span>
            <span className="context-chip-label">{chip.label}</span>
            {where && where !== chip.label && <span className="context-chip-source">{where}</span>}
          </button>
          <button type="button" className="context-chip-remove" aria-label={`Remove ${chip.label}`} onClick={() => { if (open === chip.id) setOpen(null); onRemove(chip.id); }}><X size={10} /></button>
        </li>;
      })}
    </ul>
    {expanded?.text && <div className="context-preview" role="region" aria-label={`${expanded.label} preview`}>
      <header><span>{contextTypeLabel(expanded.type)}</span>{(expanded.source.itemId || expanded.source.path || expanded.source.terminalId || expanded.source.processId || expanded.source.kind === 'agent') && <button type="button" onClick={() => onOpenSource(expanded)}>Show source</button>}</header>
      <pre>{expanded.text.length > 4000 ? `${expanded.text.slice(0, 4000)}\n…` : expanded.text}</pre>
    </div>}
  </div>;
}
