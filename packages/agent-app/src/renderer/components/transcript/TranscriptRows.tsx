import React, {useRef} from 'react';
import type {TimelineItem} from '../../../shared/protocol';
import {foldLabel, subagentCounts, type SourceIcon, type TranscriptRow} from '../../transcriptRows';
import {selectSubagent} from '../../subagentActivity';
import {getState, openSubagentsTab} from '../../store';
import {useDisclosure} from '../useDisclosure';
import {ToolCard, ToolGlyph, ImageThumbs} from '../ToolCard';
import {activityKind, viewedImages} from '../activityGrouping';
import {ElapsedText, LiveText} from './LiveParts';
import {IconStack, Row} from './Primitives';

type RowOf<K extends TranscriptRow['kind']> = Extract<TranscriptRow, {kind: K}>;

/** "Worked for 1m 38s ›" with the turn's digest; opening it shows the work it hides. */
export function FoldRow({row, onToggle}: {row: RowOf<'fold'>; onToggle: () => void}) {
  const label = foldLabel(row.state, row.durationMs);
  return <Row className="tx-fold" open={row.open} onToggle={row.hasDetail ? onToggle : undefined} title={row.hasDetail ? (row.open ? 'Hide this turn’s work' : 'Show this turn’s work') : undefined}
    trailing={!row.open && row.digest ? <span className="tx-fold-digest">{row.digest}</span> : undefined}>
    {label}
  </Row>;
}

/** A run of tool rows as one sentence ("Changed 3 files and ran 2 commands"), with its sources stacked on the right. */
export function WorkRow({row, chatId, reveal}: {row: RowOf<'work'>; chatId: string; reveal?: string}) {
  const [open, setOpen] = useDisclosure(`work:${chatId}:${row.key}`);
  const revealed = !!reveal && row.items.some(item => item.id === reveal);
  if (row.items.length === 1) return <ToolCard item={row.items[0]!} reveal={revealed}/>;
  const expanded = open || revealed;
  const images = viewedImages(row.items);
  return <div className="tx-work" data-open={expanded || undefined}>
    <Row icon={<ToolGlyph kind={activityKind(row.items).kind}/>} severity={row.severity} open={expanded} onToggle={() => setOpen(!expanded)}
      trailing={<IconStack icons={row.sources}/>} title={row.sentence}>
      {row.running ? <LiveText>{row.sentence}</LiveText> : row.sentence}
    </Row>
    {!expanded && images.length > 0 && <ImageThumbs item={row.items[0]!} paths={images}/>}
    {expanded && <div className="tx-work-items">{row.items.map(item => <ToolCard key={item.id} item={item} reveal={item.id === reveal}/>)}</div>}
  </div>;
}

/** The active turn's tail: the latest thought, a ref-driven "Working for" clock, and the current step. Never empty. */
export function LiveRow({row}: {row: RowOf<'live'>}) {
  return <div className={`tx-live is-${row.tense}`} role="status">
    {row.thought && <div className="tx-live-thought">{row.thought}</div>}
    <div className="tx-live-clock"><ElapsedText since={row.since} prefix="Working for "/></div>
    <div className="tx-live-step"><LiveText active={row.tense !== 'waiting'}>{row.label}</LiveText></div>
  </div>;
}

function openAgent(chatId: string, threadId: string | null) {
  const {snapshot} = getState(), chat = snapshot?.chats.find(entry => entry.id === chatId);
  selectSubagent(chatId, threadId);
  openSubagentsTab(chatId, chat?.folderId ?? snapshot?.folders[0]?.id, chat?.title || 'Conversation');
}
/** Arrow keys move between the card's members. */
function moveFocus(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.tx-agent')];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
  if (next) { event.preventDefault(); next.focus(); }
}
/** Every sub-agent of a run as one card: stacked avatars, live counts and one clock. Members open their own transcript. */
export function SubagentCardRow({row}: {row: RowOf<'subagents'>}) {
  const {card} = row, ref = useRef<HTMLDivElement>(null);
  const icons: SourceIcon[] = card.members.map(member => ({kind: 'agent', key: member.id, name: member.name, state: member.state}));
  const ended = card.endedAt ? Date.parse(card.endedAt) : undefined;
  return <div className="tx-agents" ref={ref} role="group" aria-label="Sub-agents" onKeyDown={moveFocus}>
    <Row icon={<IconStack icons={icons} label={`${card.members.length} sub-agents`}/>} trailing={<ElapsedText since={card.startedAt} running={card.working > 0} endedMs={ended}/>}
      severity={card.failed ? 'routine' : 'none'}>
      {card.working ? <LiveText>{subagentCounts(card)}</LiveText> : subagentCounts(card)}
    </Row>
    <div className="tx-agent-list">{card.members.map(member =>
      <button key={member.id} type="button" className={`tx-agent is-${member.state}`} title={member.reason ?? `${member.name} · Open transcript`} onClick={() => openAgent(card.chatId, member.id)}>
        <IconStack icons={[{kind: 'agent', key: member.id, name: member.name, state: member.state}]}/>
        <span className="tx-agent-name">{member.name}</span>
        <span className="tx-agent-state">{member.state === 'working' ? 'Working' : member.state === 'done' ? 'Done' : member.state === 'failed' ? 'Failed' : 'Idle'}</span>
      </button>)}
    </div>
  </div>;
}

/** Items a turn hid behind its fold, for find: they still count. */
export const itemsOfRow = (row: TranscriptRow): TimelineItem[] => row.kind === 'work' || row.kind === 'reasoning' ? row.items : 'item' in row ? [row.item] : [];
