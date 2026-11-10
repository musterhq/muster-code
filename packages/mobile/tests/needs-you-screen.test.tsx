import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {NeedsYouScreen} from '../src/screens/NeedsYouScreen';
import type {MobileNeed} from '../src/shared';
import {fakeConnection} from './fake-connection';

const at = '2026-11-10T10:00:00.000Z';
const deploy: MobileNeed = {chatId: 'c1', chatTitle: 'Deploy', itemId: 'a1', kind: 'approval', summary: 'make deploy', createdAt: at, approval: {kind: 'command', command: 'make deploy'}};
const naming: MobileNeed = {chatId: 'c2', chatTitle: 'Naming', itemId: 'q-item', kind: 'question', summary: 'Which one?', createdAt: at,
  questions: [{id: 'q1', header: 'Pick', question: 'Which one?', options: [{label: 'A'}, {label: 'B'}], allowCustomAnswer: false, multiSelect: false}]};

// Spec: MUS-SPEC-23-4F (docs/spec/clauses/23-mobile.md#mus-spec-23-4f)
test('the needs-you feed answers a question without opening the chat', async () => {
  const connection = fakeConnection({'needs.list': {needs: [deploy, naming]}});
  await render(<NeedsYouScreen connection={connection} />);
  expect(await screen.findByText('Deploy')).toBeTruthy();
  expect(screen.getByText('Naming')).toBeTruthy();
  expect(screen.getByText('make deploy')).toBeTruthy();
  await fireEvent.press(screen.getByText('B'));
  await act(async () => undefined);
  expect(connection.calls.find(call => call.method === 'question.respond')?.params).toEqual({itemId: 'q-item', answers: {q1: ['B']}});
  await act(async () => { connection.emit({type: 'needs', needs: [deploy]}); });
  expect(screen.queryByText('Naming')).toBeNull();
  expect(screen.getByText('Deploy')).toBeTruthy();
});
