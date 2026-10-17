/**
 * #html-preview: what the renderer does when an agent spins up a preview. preview_open(url) shows the agent's own browser tab
 * in the live mini player (the computer-use PiP, fed by the bridge's frames) or, with `panel`, adopts that tab into the right
 * pane; preview_close closes it; preview_open(file) opens the stored page as a sandboxed report tab. Only for the chat the
 * person is looking at: a background chat's preview waits in its mini player.
 */
import {rememberProfile} from './components/BrowserTab';
import {setMinimized} from './computerUse';
import {invoke} from './bridge';
import {openRichTab} from './richTabs';
import {closeTab, getState, notifyError, openTab} from './store';

const str = (value: unknown) => typeof value === 'string' ? value : '';

export function handlePreviewEvent(event: {type: string; [key: string]: unknown}): void {
  if (event.type !== 'previewShown' && event.type !== 'previewClosed' && event.type !== 'previewFile') return;
  const state = getState(), chatId = str(event.chatId);
  if (event.type === 'previewClosed') {
    const owner = str(event.owner);
    if (owner && state.tabs.some(tab => tab.id === owner)) closeTab(owner);
    return;
  }
  if (chatId !== state.activeChatId) return;
  if (event.type === 'previewFile') {
    const id = str(event.renderId);
    void invoke('htmlRenders.open', {id}).then(result => openRichTab('report', result.page.html, result.page.title), notifyError);
    return;
  }
  const owner = str(event.owner), profileId = str(event.profileId), url = str(event.url);
  if (!owner || !profileId) return;
  if (event.panel !== true) { setMinimized(false); return; }
  // The agent's own tab (id = owner), so the pane shows the very page the agent drives, cursor and all.
  rememberProfile(owner, profileId);
  const existing = state.tabs.find(tab => tab.id === owner);
  if (existing) openTab(existing);
  else if (url) openTab({id: owner, kind: 'browser', browserProfileId: profileId, url, title: 'Preview', chatId});
}
