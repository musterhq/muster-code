import React from 'react';
import {Brain} from 'lucide-react';
import type {TimelineItem} from '../../../shared/protocol';
import {thoughtLine} from '../../transcriptRows';
import {useDisclosure} from '../useDisclosure';
import {MessageBody} from '../MessageBody';
import {LiveText} from './LiveParts';
import {Row} from './Primitives';

/** Thoughts as one muted line with a brain icon: the newest thought, truncated; open it for every merged thought. */
export function ThoughtRow({items, chatId, reveal}: {items: readonly TimelineItem[]; chatId: string; reveal?: string}) {
  const [open, setOpen] = useDisclosure(`thought:${chatId}:${items[0]!.id}`);
  const running = items.some(item => item.status === 'running');
  const texts = items.map(item => item.text.trim()).filter(Boolean);
  const line = texts.length ? thoughtLine(texts.at(-1)!) : '';
  const label = line || (running ? 'Thinking' : 'Thought briefly');
  const expanded = (open || (!!reveal && items.some(item => item.id === reveal))) && texts.length > 0;
  return <div className="tx-thought" data-status={running ? 'running' : 'completed'}>
    <Row icon={<Brain size={14} strokeWidth={1.7}/>} open={expanded} onToggle={texts.length ? () => setOpen(!expanded) : undefined} title={line || undefined}>
      {running ? <LiveText>{label}</LiveText> : label}
    </Row>
    {expanded && <div className="tx-thought-body">{texts.map((text, index) => <MessageBody key={index} text={text}/>)}</div>}
  </div>;
}
