import {act, render, screen} from '@testing-library/react-native';
import {ChatsScreen} from '../src/screens/ChatsScreen';
import type {MobileChat} from '../src/shared';
import {fakeConnection} from './fake-connection';

const chat = (id: string, title: string, extra: Partial<MobileChat> = {}): MobileChat => ({id, title, status: 'idle', updatedAt: '2026-11-10T10:00:00.000Z', place: 'muster-code', needsYou: 0, ...extra});

// Spec: MUS-SPEC-23-4C (docs/spec/clauses/23-mobile.md#mus-spec-23-4c)
test('lists chats with status and needs-you, and updates live', async () => {
  const connection = fakeConnection({'chats.list': {chats: [chat('a', 'Release notes'), chat('b', 'Deploy', {status: 'waiting', needsYou: 1})]}});
  render(<ChatsScreen connection={connection} onOpen={() => undefined} />);
  expect(await screen.findByText('Release notes')).toBeTruthy();
  expect(screen.getByText('Deploy')).toBeTruthy();
  expect(screen.getByText('Needs you')).toBeTruthy();
  expect(screen.getAllByText('muster-code').length).toBe(2);
  await act(async () => { connection.emit({type: 'chats', chats: [chat('a', 'Release notes v2', {status: 'running'}), chat('b', 'Deploy', {status: 'waiting', needsYou: 1})]}); });
  expect(screen.getByText('Release notes v2')).toBeTruthy();
  expect(screen.getByText('Running')).toBeTruthy();
  expect(screen.queryByText('Release notes')).toBeNull();
});
