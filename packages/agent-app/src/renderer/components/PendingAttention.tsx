import {useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {ArrowUpRight, BellDot} from 'lucide-react';
import type {PendingAttentionSummary} from '../../shared/attention-protocol';
import {selectChat} from '../store';
import {useStoreSelector} from '../useStore';
import './pending-attention.css';

export function PendingAttentionList({attention, onOpenTask}: {attention?: PendingAttentionSummary; onOpenTask(chatId:string):void}) {
  if (!attention?.totalRequests) return null;
  return <section className="pending-attention" aria-label="Tasks needing input">
    <div className="pending-attention__heading"><BellDot size={14} aria-hidden="true"/><strong>Needs input</strong><span role="status" aria-live="polite" aria-atomic="true">{attention.totalRequests} pending</span></div>
    <p>Open a task to review and answer.</p>
    <ul>{attention.chats.map(chat => {
      const counts = [chat.approvalCount ? `${chat.approvalCount} approval${chat.approvalCount === 1 ? '' : 's'}` : '', chat.questionCount ? `${chat.questionCount} question${chat.questionCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
      return <li key={chat.chatId}><button type="button" onClick={() => onOpenTask(chat.chatId)} aria-label={`Open task ${chat.chatTitle}: ${counts}`}>
        <span className="pending-attention__task"><strong title={chat.chatTitle}>{chat.chatTitle}</strong><span>{counts}</span></span><ArrowUpRight size={14} aria-hidden="true"/>
      </button></li>;
    })}</ul>
  </section>;
}

/** Opens the source task. It does not promise scrolling to a particular item. */
export function PendingAttentionControl({attention, onOpenTask}: {attention?:PendingAttentionSummary; onOpenTask(chatId:string):void}) {
  const [open,setOpen] = useState(false);
  if (!attention?.totalRequests) return null;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="pending-attention-trigger" aria-label={`${attention.totalRequests} requests need input`} title="Tasks needing input"><BellDot size={16} aria-hidden="true"/><span>{attention.totalRequests}</span></Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="bottom" align="end" sideOffset={8} className="pending-attention-positioner">
      <Popover.Popup className="pending-attention-popup" data-native-preview-overlay>
        <Popover.Title className="pending-attention-popup__title">Tasks needing input</Popover.Title>
        <PendingAttentionList attention={attention} onOpenTask={chatId => {setOpen(false); onOpenTask(chatId);}}/>
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}
export function PendingAttention() {
  const attention = useStoreSelector(state => state.snapshot?.attention);
  // Unmount the control on zero, so a later request cannot reopen an old popup.
  return attention?.totalRequests ? <PendingAttentionControl attention={attention} onOpenTask={chatId => { void selectChat(chatId); }}/> : null;
}
