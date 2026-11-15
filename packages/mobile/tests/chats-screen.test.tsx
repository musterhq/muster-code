import {act, render, screen} from '@testing-library/react-native';
import {ChatsScreen} from '../src/screens/ChatsScreen';
import type {MobileChat} from '../src/shared';
import {fakeConnection, layOutTimeline} from './fake-connection';

const chat = (id: string, title: string, extra: Partial<MobileChat> = {}): MobileChat => ({id, title, status: 'idle', updatedAt: '2026-11-10T10:00:00.000Z', place: 'muster-code', needsYou: 0, ...extra});

// Spec: MUS-SPEC-23-4C (docs/spec/clauses/23-mobile.md#mus-spec-23-4c)
test('lists chats with status and needs-you, and updates live', async () => {
  const connection = fakeConnection({'chats.list': {chats: [chat('a', 'Release notes'), chat('b', 'Deploy', {status: 'waiting', needsYou: 1})]}});
  await render(<ChatsScreen connection={connection} onOpen={() => undefined} />);
  await layOutTimeline('chats-list');
  expect(await screen.findByText('Release notes')).toBeTruthy();
  expect(screen.getByText('Deploy')).toBeTruthy();
  // v3 rows: the lead word says the chat needs the person (MUS-SPEC-23-24B).
  expect(screen.getByLabelText(/^Deploy, Needs you, Needs you · muster-code$/)).toBeTruthy();
  expect(screen.getByText('muster-code')).toBeTruthy();
  await act(async () => { connection.emit({type: 'chats', chats: [chat('a', 'Release notes v2', {status: 'running'}), chat('b', 'Deploy', {status: 'waiting', needsYou: 1})]}); });
  expect(await screen.findByText('Release notes v2')).toBeTruthy();
  expect(screen.getByText(/^muster-code · Working/)).toBeTruthy();
  expect(screen.queryByText('Release notes')).toBeNull();
});
