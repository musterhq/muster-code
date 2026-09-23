import type { AutomationView } from '../shared/domains/automations-protocol';
import type { Chat } from '../shared/protocol';

/** Automations that work in any of `folderIds` (or this Project): new-chat targets bound there, chats living there,
 *  and file-watch / repository triggers on those folders. Pure so the card and tests share it. */
export function automationsForFolders(automations: readonly AutomationView[], folderIds: readonly string[], chats: readonly Pick<Chat, 'id' | 'folderId' | 'projectId'>[], projectId?: string): AutomationView[] {
  const folders = new Set(folderIds);
  return automations.filter(automation => {
    const { target, schedule } = automation;
    if ((schedule.kind === 'watch' || schedule.kind === 'repo') && folders.has(schedule.folderId)) return true;
    if (target.kind === 'new') return (target.folderId !== undefined && folders.has(target.folderId)) || (projectId !== undefined && target.projectId === projectId);
    const chat = chats.find(entry => entry.id === target.chatId);
    return Boolean(chat && ((chat.folderId && folders.has(chat.folderId)) || (projectId && chat.projectId === projectId)));
  }).sort((a, b) => Number(a.paused) - Number(b.paused) || (a.nextRunAt ?? '￿').localeCompare(b.nextRunAt ?? '￿') || a.name.localeCompare(b.name));
}

const time = (iso: string, now = Date.now()) => {
  const at = new Date(iso), sameDay = at.toDateString() === new Date(now).toDateString();
  return sameDay ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
/** One short state per row: running, paused, blocked, next run, or the trigger. */
export function scheduledDetail(automation: AutomationView, now = Date.now()): string {
  if (automation.activeRun) return 'Running';
  if (automation.paused) return 'Paused';
  if (automation.issues.length) return 'Needs attention';
  if (automation.nextRunAt) return `Next ${time(automation.nextRunAt, now)}`;
  return automation.schedule.kind === 'watch' ? 'On file changes' : automation.schedule.kind === 'repo' ? 'On repository events' : automation.summary;
}
