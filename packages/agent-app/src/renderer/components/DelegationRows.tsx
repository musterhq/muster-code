/** #44: the transcript rows and labels of chats one chat started for another. Each names the other chat and opens it. */
import React from 'react';
import {GitBranch} from 'lucide-react';
import type {Chat, TimelineItem} from '../../shared/protocol';
import type {DelegatedAttention, DelegatedFromNotice, DelegatedTaskNotice, DelegationReportData} from '../../shared/domains/delegation-protocol';
import {selectChat} from '../store';
import {useStoreSelector} from '../useStore';
import './delegation.css';

const useChat = (id: string | undefined): Chat | undefined => useStoreSelector(state => id ? state.snapshot?.chats.find(chat => chat.id === id) : undefined);

function ChatLink({id, title}: {id: string; title: string}) {
  const chat = useChat(id);
  const name = chat?.title || title;
  if (!chat) return <span className="delegation-gone" title="This chat no longer exists">{name}</span>;
  return <button type="button" onClick={() => void selectChat(id)} title={`Open “${name}”`}>{name}</button>;
}

/** "Started <title> on <model>" / "<title> finished" in the parent, "Started by <parent>" in the child. */
export function DelegationRow({item}: {item: TimelineItem}): React.ReactElement {
  if (item.data?.kind === 'delegated-from') {
    const data = item.data as unknown as DelegatedFromNotice;
    return <div className="timeline-notice delegation-row" role="note" data-testid="delegated-from"><GitBranch size={12} aria-hidden="true"/>Started by <ChatLink id={data.parentChatId} title={data.parentTitle}/></div>;
  }
  const data = item.data as unknown as DelegatedTaskNotice;
  const link = <ChatLink id={data.childChatId} title={data.title}/>;
  return <div className="timeline-notice delegation-row" role="note" data-testid="delegated-task" data-state={data.state}><GitBranch size={12} aria-hidden="true"/>
    {data.state === 'started' ? <>Started {link} on {data.model}</> : data.state === 'finished' ? <>{link} finished</> : data.state === 'stopped' ? <>{link} was stopped</> : <>{link} failed</>}
  </div>;
}

/** The message a child's finish sent its parent: "<title> finished · <first line of its reply> · Open". */
export function DelegationReportRow({item}: {item: TimelineItem}): React.ReactElement {
  const data = item.data as unknown as DelegationReportData;
  const chat = useChat(data.childChatId);
  return <div className="timeline-notice delegation-row delegation-report" role="note" data-testid="delegation-report" title={item.text}><GitBranch size={12} aria-hidden="true"/>
    <span className="delegation-report-text">{chat?.title || data.title} {data.state === 'failed' ? 'failed' : 'finished'}{data.summary ? <> · {data.summary}</> : null}</span>
    {chat ? <> · <button type="button" onClick={() => void selectChat(data.childChatId)} aria-label={`Open “${chat.title || data.title}”`}>Open</button></> : null}
  </div>;
}

/** On a parent's copy of a child's approval or question: which chat asks. */
export function DelegatedAsk({data}: {data: Record<string, unknown> | undefined}): React.ReactElement | null {
  const delegated = data?.delegated as DelegatedAttention | undefined;
  if (!delegated || typeof delegated.chatId !== 'string') return null;
  return <p className="delegation-ask" data-testid="delegated-ask"><GitBranch size={12} aria-hidden="true"/>From <ChatLink id={delegated.chatId} title={delegated.title}/>, a chat this one started</p>;
}

/** The chats a parent started, from its own "Started …" rows, with each chat's live status. */
export interface DelegatedChild {childChatId: string; title: string; model: string; status: Chat['status'] | 'deleted'}
export function delegatedChildren(items: readonly TimelineItem[], chats: readonly Chat[] | undefined): DelegatedChild[] {
  const out: DelegatedChild[] = [], seen = new Set<string>();
  for (const item of items) {
    const data = item.data as Partial<DelegatedTaskNotice> | undefined;
    if (item.kind !== 'notice' || data?.kind !== 'delegated-task' || data.state !== 'started' || typeof data.childChatId !== 'string' || seen.has(data.childChatId)) continue;
    seen.add(data.childChatId);
    const chat = chats?.find(entry => entry.id === data.childChatId);
    out.push({childChatId: data.childChatId, title: chat?.title || data.title || 'Delegated chat', model: data.model ?? '', status: chat?.status ?? 'deleted'});
  }
  return out;
}
