import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import {ChatScreen} from '../src/screens/ChatScreen';
import type {MobileChat, MobileItem} from '../src/shared';
import {fakeConnection, layOutRows, layOutTimeline} from './fake-connection';

const chat = (status: MobileChat['status']): MobileChat => ({id: 'c1', title: 'Migrate session store', status, updatedAt: '2026-11-15T10:04:00.000Z', place: 'atlas-api', needsYou: 0});
const at = (second: number) => new Date(Date.UTC(2026, 10, 15, 10, 0, second)).toISOString();
const items: MobileItem[] = [
  {id: 'u1', kind: 'user', text: 'Move the store to Streams', createdAt: at(0)},
  {id: 'r1', kind: 'reasoning', text: 'Reading the store', createdAt: at(2)},
  {id: 't1', kind: 'tool', text: 'Read src/session/store.ts', status: 'completed', createdAt: at(10)},
  {id: 't2', kind: 'tool', text: 'Edited src/session/store.ts', status: 'completed', createdAt: at(60)},
  {id: 't3', kind: 'tool', text: 'Running the session tests', status: 'inProgress', createdAt: at(134)},
  {id: 'm1', kind: 'assistant', text: 'Appends now go through XADD', createdAt: at(135)},
];
const open = (status: MobileChat['status'], list = items) => ({chat: chat(status), items: list, revision: 1, seq: 1});
const press = (label: string | RegExp) => fireEvent.press(screen.getByRole('button', {name: label}));

// Spec: MUS-SPEC-23-24C (docs/spec/clauses/23-mobile.md#mus-spec-23-24c)
test('a turn’s steps fold into one capsule, the live line names the running step, and a finished run shows its summary', async () => {
  const connection = fakeConnection({'chat.open': open('running'), 'changes.list': {runId: 'run-1', files: [{path: 'src/session/store.ts', status: 'modified', adds: 3, dels: 1, state: 'review', afterHash: 'a'.repeat(40)}], truncated: false}});
  const review = jest.fn();
  await render(<ChatScreen connection={connection} chatId="c1" onReview={review} />);
  await layOutTimeline();
  await layOutRows();
  expect(await screen.findByText('Appends now go through XADD')).toBeTruthy();
  expect(screen.getByRole('button', {name: /^Working, 4 steps/})).toBeTruthy();
  expect(screen.queryByText('Read src/session/store.ts')).toBeNull();
  expect(screen.getByTestId('now-line')).toHaveTextContent('Running the session tests');
  expect(screen.getByTestId('caret')).toBeTruthy();
  await press(/^Working, 4 steps/);
  await layOutRows();
  expect(screen.getByText('Read src/session/store.ts')).toBeTruthy();
  expect(screen.getByText('Edited src/session/store.ts')).toBeTruthy();

  (Haptics.notificationAsync as jest.Mock).mockClear();
  await act(async () => {
    connection.emit({type: 'delta', chatId: 'c1', seq: 2, ops: [{id: 't3', status: 'completed'}]});
    connection.emit({type: 'chats', chats: [chat('completed')]});
  });
  await layOutRows();
  await waitFor(() => expect(screen.getByText('Run finished')).toBeTruthy());
  expect(screen.queryByTestId('now-line')).toBeNull();
  expect(screen.queryByTestId('caret')).toBeNull();
  expect(screen.getByRole('button', {name: /^Worked 2m 14s, 4 steps/})).toBeTruthy();
  expect(screen.getByText('1 file changed')).toBeTruthy();
  await press('Review');
  expect(review).toHaveBeenCalled();
  expect((Haptics.notificationAsync as jest.Mock).mock.calls.filter(([kind]) => kind === 'success')).toHaveLength(1);
});

// Spec: MUS-SPEC-23-24D (docs/spec/clauses/23-mobile.md#mus-spec-23-24d)
test('while a turn runs Send becomes Stop, and Stop stops the turn on the computer with a light tap', async () => {
  const connection = fakeConnection({'chat.open': open('running'), 'chat.stop': {}, 'changes.list': {runId: null, files: [], truncated: false}});
  await render(<ChatScreen connection={connection} chatId="c1" />);
  await layOutTimeline();
  await screen.findByText('Migrate session store');
  expect(screen.queryByText(/Working ·/)).toBeNull();
  expect(screen.queryByRole('button', {name: 'Send'})).toBeNull();
  (Haptics.impactAsync as jest.Mock).mockClear();
  await press('Stop');
  await act(async () => undefined);
  expect(connection.calls).toContainEqual({method: 'chat.stop', params: {id: 'c1'}});
  expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
  await fireEvent.changeText(screen.getByTestId('composer-input'), 'also keep the old keys');
  expect(screen.getByRole('button', {name: 'Steer'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Stop'})).toBeNull();
  expect(screen.getByText(/goes to the running turn/i)).toBeTruthy();
});

// Spec: MUS-SPEC-23-24E (docs/spec/clauses/23-mobile.md#mus-spec-23-24e)
test('the composer shows its chips only while it is focused', async () => {
  const connection = fakeConnection({'chat.open': open('completed', items.slice(0, 1)), 'changes.list': {runId: null, files: [], truncated: false}});
  await render(<ChatScreen connection={connection} chatId="c1" pickAttachment={async () => null} />);
  await layOutTimeline();
  await screen.findByText('Migrate session store');
  expect(screen.getByRole('button', {name: 'Attach'})).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Send'})).toBeTruthy();
  for (const chip of ['Photo', 'Camera', 'File']) expect(screen.queryByRole('button', {name: chip})).toBeNull();
  await fireEvent(screen.getByTestId('composer-input'), 'focus');
  for (const chip of ['Photo', 'Camera', 'File']) expect(screen.getByRole('button', {name: chip})).toBeTruthy();
  await fireEvent(screen.getByTestId('composer-input'), 'blur');
  for (const chip of ['Photo', 'Camera', 'File']) expect(screen.queryByRole('button', {name: chip})).toBeNull();
});
