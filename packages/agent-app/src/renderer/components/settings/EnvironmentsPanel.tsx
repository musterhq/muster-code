import React, {useState} from 'react';
import type {ChatEnvironmentKind} from '../../../shared/domains/sandbox-protocol';
import {invoke} from '../../bridge';
import {activeChat, notifyError} from '../../store';
import {useStore} from '../../useStore';
import {HOST_ENV_LABEL, SANDBOX_ENV_LABEL, useChatEnvironment} from '../EnvironmentFooter';

/** PRO-07: where agents run, reachable from Settings. The choice itself stays per chat (the composer footer sets it too). */
function ActiveChatEnvironment({chatId, title, running}: {chatId: string; title: string; running: boolean}): React.ReactElement {
  const {environment, refresh} = useChatEnvironment(chatId);
  const [busy, setBusy] = useState(false);
  const choose = async (env: ChatEnvironmentKind) => {
    setBusy(true);
    try { await invoke('sandbox.chatEnvironment.set', {chatId, env, mode: 'copy'}); refresh(); }
    catch (cause) { notifyError(cause); }
    finally { setBusy(false); }
  };
  const current = environment?.env;
  return <div className="preference-row" role="group" aria-label="This chat’s environment">
    <span className="preference-copy">
      <strong>{title || 'Current chat'}</strong>
      <span>{!environment ? 'Checking…' : current === 'sandbox' ? `${SANDBOX_ENV_LABEL}${environment.ready ? ' · ready' : environment.reason ? ` · ${environment.reason}` : ' · not running'}` : `${HOST_ENV_LABEL} · edits your folder directly`}</span>
      <span className="preference-scope">This chat only{running ? ' · change it after the current run' : ''}</span>
    </span>
    <span className="preference-control">
      <span className="preference-segmented" role="radiogroup" aria-label="Environment for this chat">
        {(['host', 'sandbox'] as const).map(env => <button key={env} type="button" role="radio" aria-checked={current === env} disabled={busy || running || !environment} onClick={() => { if (current !== env) void choose(env); }}>{env === 'host' ? 'This Mac' : 'Sandbox'}</button>)}
      </span>
    </span>
  </div>;
}

export function EnvironmentsPanel(): React.ReactElement {
  useStore();
  const chat = activeChat();
  const running = chat?.status === 'running' || chat?.status === 'stopping';
  return <>
    <div className="preference-group">
      <div className="preference-row" role="group" aria-label={HOST_ENV_LABEL}>
        <span className="preference-copy"><strong>{HOST_ENV_LABEL}</strong><span>The agent works in the chat’s folder with the access level you choose in the composer. Always available.</span><span className="preference-scope">Default for new chats</span></span>
      </div>
      <div className="preference-row" role="group" aria-label={SANDBOX_ENV_LABEL}>
        <span className="preference-copy"><strong>{SANDBOX_ENV_LABEL}</strong><span>Commands and edits run in an isolated copy of the folder inside a Linux container. Review the differences and apply them back to this Mac when you are ready. The agent browser still runs on this Mac.</span><span className="preference-scope">Chosen per chat</span></span>
      </div>
    </div>
    <h3 className="preference-group-title">Current chat</h3>
    <div className="preference-group">
      {chat && chat.folderId ? <ActiveChatEnvironment key={chat.id} chatId={chat.id} title={chat.title} running={running} />
        : <div className="preference-row"><span className="preference-copy"><strong>No folder chat open</strong><span>Open a chat in a folder to choose where its agent runs.</span></span></div>}
    </div>
  </>;
}
