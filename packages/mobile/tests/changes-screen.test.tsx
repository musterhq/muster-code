import {act, render, screen} from '@testing-library/react-native';
import {fireGestureHandler, getByGestureTestId} from 'react-native-gesture-handler/jest-utils';
import {State} from 'react-native-gesture-handler';
import {ChangesScreen} from '../src/screens/ChangesScreen';
import type {MobileChange} from '../src/shared';
import {fakeConnection} from './fake-connection';

const swipe = (testID: string, dx: number) => fireGestureHandler(getByGestureTestId(testID), [
  {state: State.BEGAN, translationX: 0, velocityX: 0},
  {state: State.ACTIVE, translationX: dx / 2, velocityX: dx * 4},
  {state: State.ACTIVE, translationX: dx, velocityX: dx * 4},
  {state: State.END, translationX: dx, velocityX: dx * 4},
]);
const hash = (c: string) => c.repeat(40);
const files: MobileChange[] = [
  {path: 'src/session/store.ts', status: 'modified', adds: 48, dels: 18, state: 'review', afterHash: hash('a')},
  {path: 'src/session/stream-key.ts', status: 'added', adds: 22, dels: 0, state: 'kept', afterHash: hash('b')},
  {path: 'src/config/redis.ts', status: 'modified', adds: 6, dels: 1, state: 'review', afterHash: hash('c')},
];

// Spec: MUS-SPEC-23-24N (docs/spec/clauses/23-mobile.md#mus-spec-23-24n)
test('the changes screen shows the review ring and files, keeps and undoes by swipe, and hides actions when read only', async () => {
  const connection = fakeConnection({'changes.list': {runId: 'run-1', files, truncated: false}, 'changes.keep': {state: 'kept'}, 'changes.undo': {stale: false}});
  const view = await render(<ChangesScreen connection={connection} chatId="c1" onOpenFile={() => undefined} />);
  expect(await screen.findByLabelText('Reviewed 1 of 3')).toBeTruthy();
  expect(screen.getByText('1 kept · 2 to review')).toBeTruthy();
  expect(screen.getByText('store.ts')).toBeTruthy();
  expect(screen.getAllByText('src/session')).toHaveLength(2);
  expect(screen.getByLabelText('stream-key.ts, Kept')).toBeTruthy();
  expect(screen.getByLabelText('store.ts, 48 added, 18 removed')).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Keep all'})).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Undo all'})).toBeTruthy();
  await act(async () => { swipe('swipe-src/session/store.ts', 260); });
  await act(async () => { swipe('swipe-src/config/redis.ts', -260); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(connection.calls.filter(call => call.method === 'changes.keep').map(call => call.params)).toEqual([{chatId: 'c1', runId: 'run-1', path: 'src/session/store.ts', hunkIds: ['*']}]);
  expect(connection.calls.filter(call => call.method === 'changes.undo').map(call => call.params)).toEqual([{chatId: 'c1', runId: 'run-1', path: 'src/config/redis.ts', afterHash: hash('c')}]);
  expect(screen.getByLabelText('store.ts, Kept')).toBeTruthy();
  expect(screen.getByLabelText('redis.ts, Undone')).toBeTruthy();
  expect(screen.getByLabelText('Reviewed 3 of 3')).toBeTruthy();
  await view.unmount();

  const reader = fakeConnection({'changes.list': {runId: 'run-1', files, truncated: false}}, 'read-only');
  await render(<ChangesScreen connection={reader} chatId="c1" onOpenFile={() => undefined} />);
  expect(await screen.findByLabelText('Reviewed 1 of 3')).toBeTruthy();
  expect(screen.getByText('store.ts')).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Keep all'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Undo all'})).toBeNull();
  expect(() => getByGestureTestId('swipe-src/session/store.ts')).toThrow();
});
