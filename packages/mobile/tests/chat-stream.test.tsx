import {act, render, screen} from '@testing-library/react-native';
import {ChatScreen} from '../src/screens/ChatScreen';
import type {MobileChat, MobileItem} from '../src/shared';
import {fakeConnection, layOutTimeline} from './fake-connection';

const at = '2026-11-14T10:00:00.000Z';
const chat: MobileChat = {id: 'c1', title: 'Release notes', status: 'running', updatedAt: at, place: null, needsYou: 0};
const item = (id: string, kind: MobileItem['kind'], text: string): MobileItem => ({id, kind, text, createdAt: at});

// Spec: MUS-SPEC-23-15B (docs/spec/clauses/23-mobile.md#mus-spec-23-15b)
test('applies stream deltas in order, resyncs after a gap, and reopens the chat on a new connection', async () => {
  let answerOpen: (value: unknown) => void = () => undefined;
  const opens: unknown[] = [];
  const connection = fakeConnection({
    'chat.open': (params: unknown) => { opens.push(params); return opens.length === 1
      ? new Promise(resolve => { answerOpen = resolve; })
      : {chat, items: [item('u1', 'user', 'write the notes'), item('m1', 'assistant', 'Resynced reply')], revision: 9, seq: 40}; },
  });
  await render(<ChatScreen connection={connection} chatId="c1" />);
  await layOutTimeline();
  expect(opens[0]).toEqual({id: 'c1', deltas: true});
  // A delta that arrives before chat.open answers is kept and applied after it.
  await act(async () => { connection.emit({type: 'delta', chatId: 'c1', seq: 1, ops: [{id: 'm1', append: 'lo'}]}); });
  await act(async () => { answerOpen({chat, items: [item('u1', 'user', 'write the notes'), item('m1', 'assistant', 'Hel')], revision: 1, seq: 0}); });
  expect(await screen.findByText('Hello')).toBeTruthy();
  await act(async () => {
    connection.emit({type: 'delta', chatId: 'c1', seq: 2, ops: [{id: 'm1', append: ' world'}]});
    connection.emit({type: 'delta', chatId: 'c1', seq: 3, ops: [{item: item('t1', 'tool', 'Ran npm test')}]});
  });
  expect(await screen.findByText('Hello world')).toBeTruthy();
  expect(await screen.findByText('Ran npm test')).toBeTruthy();
  expect(opens).toHaveLength(1);
  // Delta 4 never came: the screen reopens the chat and shows the desktop's state.
  await act(async () => { connection.emit({type: 'delta', chatId: 'c1', seq: 5, ops: [{id: 'm1', append: ' lost'}]}); });
  expect(opens).toHaveLength(2);
  expect(await screen.findByText('Resynced reply')).toBeTruthy();
  expect(screen.queryByText('Hello world')).toBeNull();
  expect(screen.queryByText(/lost/)).toBeNull();
  // A new connection (after a reconnect) opens the chat again.
  const next = fakeConnection({'chat.open': {chat, items: [item('m1', 'assistant', 'After reconnect')], revision: 10, seq: 0}});
  await screen.rerender(<ChatScreen connection={next} chatId="c1" />);
  await layOutTimeline();
  expect(next.calls.filter(call => call.method === 'chat.open')).toHaveLength(1);
  expect(await screen.findByText('After reconnect')).toBeTruthy();
});

// Spec: MUS-SPEC-23-23C (docs/spec/clauses/23-mobile.md#mus-spec-23-23c)
test('a remove op takes the row off the chat screen', async () => {
  const connection = fakeConnection({'chat.open': {chat, items: [item('u1', 'user', 'first question'), item('u2', 'user', 'replaced question'), item('m1', 'assistant', 'the answer')], revision: 1, seq: 0}});
  await render(<ChatScreen connection={connection} chatId="c1" />);
  await layOutTimeline();
  expect(await screen.findByText('replaced question')).toBeTruthy();
  await act(async () => { connection.emit({type: 'delta', chatId: 'c1', seq: 1, ops: [{remove: 'u2'}]}); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(screen.queryByText('replaced question')).toBeNull();
  expect(screen.getByText('first question')).toBeTruthy();
  expect(screen.getByText('the answer')).toBeTruthy();
  expect(connection.calls.filter(call => call.method === 'chat.open')).toHaveLength(1);
});
