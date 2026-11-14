import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {ChatScreen} from '../src/screens/ChatScreen';
import {setRenderProbe} from '../src/perf';
import type {MobileChat, MobileItem} from '../src/shared';
import {fakeConnection} from './fake-connection';

const at = '2026-11-14T10:00:00.000Z';
const chat: MobileChat = {id: 'c1', title: 'Long chat', status: 'running', updatedAt: at, place: null, needsYou: 0};
const items: MobileItem[] = Array.from({length: 2000}, (_, index) => index === 1999
  ? {id: 'reply', kind: 'assistant', text: 'Streaming', createdAt: at}
  : {id: `i${index}`, kind: index % 2 ? 'assistant' : 'user', text: `Message number ${index}`, createdAt: at});

afterEach(() => setRenderProbe(null));

// Spec: MUS-SPEC-23-16A (docs/spec/clauses/23-mobile.md#mus-spec-23-16a)
test('a 2,000-row chat mounts a window and streaming re-renders only the streaming row', async () => {
  const renders = new Map<string, number>();
  setRenderProbe((name, id) => { if (name === 'timeline-row') renders.set(id, (renders.get(id) ?? 0) + 1); });
  const connection = fakeConnection({'chat.open': {chat, items, revision: 1, seq: 0}});
  await render(<ChatScreen connection={connection} chatId="c1" />);
  await act(async () => { fireEvent(screen.getByTestId('chat-timeline'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 800}}}); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.getByText('Streaming')).toBeTruthy();
  const mounted = screen.queryAllByText(/^Message number /).length;
  expect(mounted).toBeLessThan(100);
  expect(screen.getByText('Message number 1998')).toBeTruthy();
  renders.clear();
  for (let seq = 1; seq <= 20; seq++) await act(async () => { connection.emit({type: 'delta', chatId: 'c1', seq, ops: [{id: 'reply', append: ` piece${seq}`}]}); });
  expect(screen.getByText(/ piece20$/)).toBeTruthy();
  expect([...renders.keys()]).toEqual(['reply']);
  expect(renders.get('reply')).toBeGreaterThanOrEqual(20);
  expect(renders.get('reply')).toBeLessThanOrEqual(30);
  renders.clear();
  await act(async () => { connection.emit({type: 'delta', chatId: 'c1', seq: 21, ops: [{item: {id: 'tool-1', kind: 'tool', text: 'Ran npm test', createdAt: at}}]}); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(screen.getByText('Ran npm test')).toBeTruthy();
  expect([...renders.keys()]).toEqual(['tool-1']);
});
