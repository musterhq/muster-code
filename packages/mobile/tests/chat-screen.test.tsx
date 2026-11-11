import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {ChatScreen} from '../src/screens/ChatScreen';
import type {MobileChat, MobileItem} from '../src/shared';
import {fakeConnection} from './fake-connection';

const chat = (status: MobileChat['status'] = 'idle'): MobileChat => ({id: 'c1', title: 'Release notes', status, updatedAt: '2026-11-10T10:00:00.000Z', place: null, needsYou: 0});
const at = '2026-11-10T10:00:00.000Z';

// Spec: MUS-SPEC-23-4D (docs/spec/clauses/23-mobile.md#mus-spec-23-4d)
test('streams a reply, sends when idle and steers while running', async () => {
  const connection = fakeConnection({'chat.open': {chat: chat(), items: [], revision: 1}, 'chat.send': {runId: 'r1'}, 'chat.steer': {steered: true}});
  await render(<ChatScreen connection={connection} chatId="c1" />);
  expect(await screen.findByText('Release notes')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('Message'), 'write the notes');
  await fireEvent.press(screen.getByText('Send'));
  await act(async () => undefined);
  expect(connection.calls.find(call => call.method === 'chat.send')?.params).toMatchObject({id: 'c1', text: 'write the notes'});
  expect(screen.getByPlaceholderText('Message').props.value).toBe('');
  const reply = (text: string): MobileItem => ({id: 'm1', kind: 'assistant', text, createdAt: at});
  await act(async () => {
    connection.emit({type: 'chats', chats: [chat('running')]});
    connection.emit({type: 'items', chatId: 'c1', items: [{id: 'u1', kind: 'user', text: 'write the notes', createdAt: at}, reply('Hello ')], revision: 2});
    connection.emit({type: 'items', chatId: 'c1', items: [reply('Hello world')], revision: 3});
  });
  expect(screen.getByText('Hello world')).toBeTruthy();
  expect(screen.getByText('write the notes')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('Message'), 'also add dates');
  await fireEvent.press(screen.getByText('Steer'));
  await act(async () => undefined);
  expect(connection.calls.find(call => call.method === 'chat.steer')?.params).toMatchObject({id: 'c1', text: 'also add dates'});
});

const approval: MobileItem = {id: 'a1', kind: 'approval', text: 'Approve command', status: 'pending', createdAt: at, approval: {kind: 'command', command: 'npm test', cwd: '/work'}};

// Spec: MUS-SPEC-23-4E (docs/spec/clauses/23-mobile.md#mus-spec-23-4e)
test('approves or declines in place, and read-only hides the actions', async () => {
  const acting = fakeConnection({'chat.open': {chat: chat('waiting'), items: [approval], revision: 1}});
  const view = await render(<ChatScreen connection={acting} chatId="c1" />);
  expect(await screen.findByText('npm test')).toBeTruthy();
  await fireEvent.press(screen.getByText('Approve'));
  await act(async () => undefined);
  expect(acting.calls.find(call => call.method === 'approval.respond')?.params).toEqual({itemId: 'a1', decision: 'accept'});
  expect(screen.getByText('Decline')).toBeTruthy();
  await view.unmount();
  const reader = fakeConnection({'chat.open': {chat: chat('waiting'), items: [approval], revision: 1}}, 'read-only');
  await render(<ChatScreen connection={reader} chatId="c1" />);
  expect(await screen.findByText('npm test')).toBeTruthy();
  expect(screen.getAllByText('Read only: allow this phone to act in Settings on your computer').length).toBeGreaterThan(0);
  expect(screen.queryByText('Approve')).toBeNull();
  expect(screen.getByPlaceholderText('Message').props.editable).toBe(false);
});

// Spec: MUS-SPEC-23-12C (docs/spec/clauses/23-mobile.md#mus-spec-23-12c)
test('attaches a photo from the composer, uploads it in chunks and sends it with the message', async () => {
  const {toBase64} = require('../../agent-app/src/shared/mobile/bytes.ts');
  const photo = new Uint8Array(70_000).map((_, index) => index % 251);
  const received: number[] = [];
  const connection = fakeConnection({
    'chat.open': {chat: chat(), items: [], revision: 1}, 'chat.send': {runId: 'r1'},
    'upload.start': {uploadId: 'u1', chunkBytes: 32 * 1024},
    'upload.chunk': (params: {offset: number; data: string}) => { received.push(params.offset); return {received: params.offset + Buffer.from(params.data, 'base64').length}; },
    'upload.finish': {attachment: {id: 'att-1', name: 'IMG_0042.jpg', mime: 'image/jpeg', size: photo.length, kind: 'image'}},
  });
  const pickAttachment = jest.fn(async (_source: 'photo' | 'camera' | 'file') => ({name: 'IMG_0042.jpg', mime: 'image/jpeg', base64: toBase64(photo)}));
  await render(<ChatScreen connection={connection} chatId="c1" pickAttachment={pickAttachment} />);
  expect(await screen.findByText('Release notes')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Attach'));
  await fireEvent.press(screen.getByText('Photo'));
  expect(await screen.findByText('IMG_0042.jpg')).toBeTruthy();
  expect(pickAttachment).toHaveBeenCalledWith('photo');
  expect(connection.calls.find(call => call.method === 'upload.start')?.params).toMatchObject({chatId: 'c1', name: 'IMG_0042.jpg', mime: 'image/jpeg', size: photo.length});
  expect(received).toEqual([0, 32 * 1024, 64 * 1024]);
  await fireEvent.changeText(screen.getByPlaceholderText('Message'), 'what is this?');
  await fireEvent.press(screen.getByText('Send'));
  await act(async () => undefined);
  expect(connection.calls.find(call => call.method === 'chat.send')?.params).toMatchObject({id: 'c1', text: 'what is this?', attachmentIds: ['att-1']});
  expect(screen.queryByText('IMG_0042.jpg')).toBeNull();
});
