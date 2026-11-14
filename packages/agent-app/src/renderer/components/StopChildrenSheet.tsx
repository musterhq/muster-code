/** #44: Stop on a chat that started chats which are still working asks what to stop, with three explicit choices.
 *  Cancel (and Esc, and a click outside) stops nothing. */
import React, { useEffect, useSyncExternalStore } from 'react';
import { ConfirmSheet } from './ConfirmSheet';
import { currentStopPrompt, registerStopHost, subscribeStopPrompt, type StopChoice } from '../stopChoice';

export function StopChildrenHost(): React.ReactElement | null {
  useEffect(() => registerStopHost(), []);
  const current = useSyncExternalStore(subscribeStopPrompt, currentStopPrompt);
  const names = current?.names ?? [];
  const list = names.slice(0, 3).map(name => `“${name}”`).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  const answer = (choice: StopChoice) => current?.resolve(choice);
  return <ConfirmSheet open={!!current} testId="stop-children-confirm" title="Stop the chats this chat started?"
    description={`“${current?.title ?? ''}” started ${names.length === 1 ? 'a chat that is' : `${names.length} chats that are`} still working: ${list}.`}
    onCancel={() => answer('cancel')}
    actions={[{ label: 'Cancel', run: () => answer('cancel') }, { label: 'Stop this chat only', run: () => answer('one') }, { label: 'Stop all', primary: true, run: () => answer('all') }]} />;
}
