import React,{useEffect} from 'react';
import {ChevronRight} from 'lucide-react';
import {Collapsible} from '@base-ui/react/collapsible';
import type {TimelineItem} from '../../shared/protocol';
import {useDisclosure} from './useDisclosure';
import {Shimmer} from './TurnStatus';
import {MessageBody} from './MessageBody';
import {elapsed,thoughtLabel} from './turnStatusModel';
import './reasoning-row.css';

/**
 * Codex reasoning row. Collapsed: "Thinking" (shimmering while it streams) or
 * "Thought for 12s". Click, Enter or Space opens it; the reasoning then streams
 * inline as deltas arrive, in the message typography but muted. The open state is
 * kept per item across re-renders and virtualised remounts. A reasoning item with
 * no text (a provider that only reports that it is thinking) is a plain label,
 * never an expander that opens onto nothing.
 */
export function ReasoningRow({item,nextAt,reveal=false}:{item:TimelineItem;nextAt?:string;reveal?:boolean}):React.ReactElement {
  const [open,setOpen]=useDisclosure('reasoning:'+item.id);
  const hasText=item.text.trim().length>0;
  useEffect(()=>{if(reveal&&hasText&&!open)setOpen(true);},[reveal,hasText]);
  const running=item.status==='running';
  const label=<Shimmer active={running}>{thoughtLabel(item.status,elapsed(item.createdAt,nextAt))}</Shimmer>;
  if(!hasText)return <div className="reasoning-row is-empty" data-status={item.status}><span className="reasoning-label">{label}</span></div>;
  return <Collapsible.Root open={open} onOpenChange={setOpen} className="reasoning-row" data-status={item.status}>
    <Collapsible.Trigger className="reasoning-trigger"><span className="reasoning-label">{label}</span><ChevronRight className="tool-chevron" size={13} aria-hidden="true"/></Collapsible.Trigger>
    <Collapsible.Panel className="activity-disclosure"><div className="reasoning-body"><MessageBody text={item.text}/></div></Collapsible.Panel>
  </Collapsible.Root>;
}
