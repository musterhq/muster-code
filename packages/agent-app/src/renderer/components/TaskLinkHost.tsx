/**
 * `muster://task/<companyId>/<issueId>?host=…&identifier=…` (the optional Paperclip plugin's "Open in Muster"): opens the task and offers Work locally,
 * but only when the host is a server this Mac is already connected to. Otherwise it says to connect first. It never connects by itself.
 */
import { useEffect } from 'react';
import { invoke, subscribe } from '../bridge';
import { openTaskInOrg } from '../orgStore';
import { openAppSettings, pushNotice } from '../store';

export function TaskLinkHost(): null {
  useEffect(() => subscribe(event => {
    if (event.type !== 'taskLink') return;
    void invoke('orgs.link', { companyId: event.companyId, issueId: event.issueId, host: event.host, identifier: event.identifier }).then(async result => {
      if (result.status === 'connect-first') { pushNotice(`That link is for ${new URL(result.host).host}. Connect to it first in Settings › Integrations; Muster never connects from a link.`, { kind: 'info', action: { label: 'Open settings', run: () => openAppSettings('integrations') } }); return; }
      if (result.status === 'not-found') { pushNotice(`${result.identifier ?? 'That task'} is not on the server you are connected to, or it is not shared with you.`, { kind: 'info' }); return; }
      await openTaskInOrg(event.companyId, result.taskId);
      pushNotice(result.mine ? 'This task is assigned to you. Use Work locally to start on this Mac.' : 'Opened the task. Work locally takes it for you when you are ready.', { kind: 'info' });
    }, cause => pushNotice(cause instanceof Error ? cause.message : String(cause), { kind: 'error' }));
  }), []);
  return null;
}
