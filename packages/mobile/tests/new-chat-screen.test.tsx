import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {NewChatScreen} from '../src/screens/NewChatScreen';
import type {MobileChat} from '../src/shared';
import {fakeConnection} from './fake-connection';

const made: MobileChat = {id: 'c9', title: 'New chat', status: 'idle', updatedAt: '2026-11-11T10:00:00.000Z', place: 'web-app', needsYou: 0};
const options = {
  places: [{kind: 'project', id: 'p1', name: 'Launch'}, {kind: 'folder', id: 'f1', name: 'web-app'}],
  providers: [{id: 'codex', name: 'Codex', models: [{id: 'gpt-main', name: 'Main', images: true}]}, {id: 'fake', name: 'Fake', models: [{id: 'fake-model', name: 'Fake model', images: false}, {id: 'fake-pro', name: 'Fake Pro', images: true}]}],
};

// Spec: MUS-SPEC-23-11C (docs/spec/clauses/23-mobile.md#mus-spec-23-11c)
test('the new chat sheet picks a folder or project, a provider and a model, and opens the chat it made', async () => {
  const connection = fakeConnection({'chat.options': options, 'chat.create': {chat: made}});
  const onCreated = jest.fn();
  const view = await render(<NewChatScreen connection={connection} onCreated={onCreated} />);
  expect(await screen.findByText('Launch')).toBeTruthy();
  expect(screen.getByText('web-app')).toBeTruthy();
  await fireEvent.press(screen.getByText('web-app'));
  await fireEvent.press(screen.getByText('Fake'));
  // Only the chosen provider's models are offered.
  expect(screen.queryByText('Main')).toBeNull();
  await fireEvent.press(screen.getByText('Fake Pro'));
  await fireEvent.press(screen.getByText('Start chat'));
  await act(async () => undefined);
  expect(connection.calls.find(call => call.method === 'chat.create')?.params).toEqual({folderId: 'f1', providerId: 'fake', model: 'fake-pro'});
  expect(onCreated).toHaveBeenCalledWith('c9');
  await view.unmount();
  const reader = fakeConnection({'chat.options': options}, 'read-only');
  await render(<NewChatScreen connection={reader} onCreated={onCreated} />);
  expect(await screen.findByText('Read only: allow this phone to act in Settings on your computer')).toBeTruthy();
  expect(screen.queryByText('Start chat')).toBeNull();
  expect(reader.calls.some(call => call.method === 'chat.options')).toBe(false);
});
