import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {ChatScreen} from '../src/screens/ChatScreen';
import {OfflineCache} from '../src/offline/cache';
import {offlineConnection} from '../src/offline/connection';
import {flushOutbox} from '../src/offline/outbox';
import {MobileError, type MobileChat, type MobileItem} from '../src/shared';
import {fakeConnection, layOutTimeline} from './fake-connection';
import {nodeSqlite} from './sqlite';

const at = new Date(2026, 10, 14, 14, 2).getTime();
const chat: MobileChat = {id: 'c1', title: 'Migrate session store', status: 'idle', updatedAt: new Date(at).toISOString(), place: 'atlas-api', needsYou: 1};
const items: MobileItem[] = [
  {id: 'a1', kind: 'assistant', text: 'Ready to delete the old lists.', createdAt: chat.updatedAt},
  {id: 'p1', kind: 'approval', text: 'Run a command', status: 'pending', createdAt: chat.updatedAt, approval: {kind: 'command', command: 'redis-cli DEL sessions:old'}},
];

// Spec: MUS-SPEC-23-20B (docs/spec/clauses/23-mobile.md#mus-spec-23-20b)
test('messages written offline are queued, go out in order once on reconnect, and approvals are never queued', async () => {
  const cache = new OfflineCache(nodeSqlite());
  cache.saveList('studio', 'access', 'act', at);
  cache.saveChat('studio', chat, items, at);
  const connection = offlineConnection({computerId: 'studio', name: 'Studio Mac', cache, retry: () => undefined});
  await render(<ChatScreen connection={connection} chatId="c1" />);
  await layOutTimeline();
  expect(await screen.findByText('Ready to delete the old lists.')).toBeTruthy();
  // The approval is shown, but it can't be answered or queued offline.
  expect(screen.getByText('redis-cli DEL sessions:old')).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Decline'})).toBeNull();
  expect(screen.getByText(/answer this when Studio Mac is back/)).toBeTruthy();
  for (const text of ['Also keep the old lists for 7 days', 'Then delete them in a separate job']) {
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText(/Queued until Studio Mac is back/), text); });
    await act(async () => { fireEvent.press(screen.getByRole('button', {name: 'Send'})); });
  }
  expect(screen.getByText('Also keep the old lists for 7 days')).toBeTruthy();
  expect(screen.getAllByText('Waiting to send')).toHaveLength(2);
  const queued = cache.outbox('studio');
  expect(queued.map(entry => entry.text)).toEqual(['Also keep the old lists for 7 days', 'Then delete them in a separate job']);
  expect(queued.every(entry => entry.chatId === 'c1')).toBe(true);

  // First reconnect: the link drops during the first send. Nothing after it is sent, nothing is lost.
  let fail = true;
  const flaky = fakeConnection({'chat.send': () => { if (fail) { fail = false; throw new MobileError('closed', 'The connection closed.'); } return {runId: 'r'}; }});
  await flushOutbox(flaky, cache, 'studio');
  expect(flaky.calls.map(call => call.method)).toEqual(['chat.send']);
  expect(cache.outbox('studio')).toHaveLength(2);
  // Second reconnect: both go, in order, with the request ids they were written with (the computer keeps one run per id).
  const live = fakeConnection({'chat.send': {runId: 'r'}});
  await Promise.all([flushOutbox(live, cache, 'studio'), flushOutbox(live, cache, 'studio')]);
  expect(live.calls.map(call => call.params)).toEqual(queued.map(entry => ({id: 'c1', text: entry.text, requestId: entry.id})));
  expect((flaky.calls[0]!.params as {requestId: string}).requestId).toBe(queued[0]!.id);
  expect(cache.outbox('studio')).toEqual([]);
});
