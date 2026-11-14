import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {ChatsScreen} from '../src/screens/ChatsScreen';
import {ChatScreen} from '../src/screens/ChatScreen';
import {OfflineCache} from '../src/offline/cache';
import {offlineConnection} from '../src/offline/connection';
import type {MobileChat, MobileItem} from '../src/shared';
import {layOutTimeline} from './fake-connection';
import {nodeSqlite} from './sqlite';

const synced = new Date(2026, 10, 14, 14, 2).getTime();
const running: MobileChat = {id: 'c1', title: 'Migrate session store to Redis Streams', status: 'running', updatedAt: new Date(synced).toISOString(), place: 'atlas-api', needsYou: 0};
const done: MobileChat = {id: 'c2', title: 'Bump React Native', status: 'completed', updatedAt: new Date(synced).toISOString(), place: 'mobile-shell', needsYou: 0};
const items: MobileItem[] = [
  {id: 'u1', kind: 'user', text: 'Move the session store from Redis lists to Streams.', createdAt: running.updatedAt},
  {id: 'a1', kind: 'assistant', text: 'Appends now go through XADD.', createdAt: running.updatedAt},
];

// Spec: MUS-SPEC-23-20A (docs/spec/clauses/23-mobile.md#mus-spec-23-20a)
test('with no connection the chats and the open chat come from the cache, with a calm banner, Retry and was running', async () => {
  const cache = new OfflineCache(nodeSqlite());
  cache.saveList('studio', 'chats', [running, done], synced);
  cache.saveChat('studio', running, items, synced);
  const retry = jest.fn();
  const connection = offlineConnection({computerId: 'studio', name: 'Studio Mac', cache, retry});
  const list = await render(<ChatsScreen connection={connection} onOpen={() => undefined} />);
  await layOutTimeline('chats-list');
  expect(await screen.findByText('Migrate session store to Redis Streams')).toBeTruthy();
  expect(screen.getByText(/^atlas-api · Was running/)).toBeTruthy();
  expect(screen.getByText('Bump React Native')).toBeTruthy();
  expect(screen.getByText('Offline · last update 14:02')).toBeTruthy();
  expect(screen.getByText(/Studio Mac/)).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByRole('button', {name: 'Retry'})); });
  expect(retry).toHaveBeenCalledTimes(1);
  await list.unmount();
  await render(<ChatScreen connection={connection} chatId="c1" />);
  await layOutTimeline();
  expect(await screen.findByText('Appends now go through XADD.')).toBeTruthy();
  expect(screen.getByText('Move the session store from Redis lists to Streams.')).toBeTruthy();
  expect(screen.getByText('Offline · last update 14:02')).toBeTruthy();
});
