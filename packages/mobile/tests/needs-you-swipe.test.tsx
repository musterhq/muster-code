import {act, render, screen} from '@testing-library/react-native';
import {fireGestureHandler, getByGestureTestId} from 'react-native-gesture-handler/jest-utils';
import {State} from 'react-native-gesture-handler';
import {NeedsYouScreen} from '../src/screens/NeedsYouScreen';
import type {MobileNeed} from '../src/shared';
import {fakeConnection} from './fake-connection';

const at = '2026-11-14T10:00:00.000Z';
const need = (itemId: string, command: string): MobileNeed => ({chatId: 'c1', chatTitle: 'Release', itemId, kind: 'approval', summary: command, createdAt: at, approval: {kind: 'command', command}});
const swipe = (testID: string, dx: number) => fireGestureHandler(getByGestureTestId(testID), [
  {state: State.BEGAN, translationX: 0, velocityX: 0},
  {state: State.ACTIVE, translationX: dx / 2, velocityX: dx * 4},
  {state: State.ACTIVE, translationX: dx, velocityX: dx * 4},
  {state: State.END, translationX: dx, velocityX: dx * 4},
]);

// Spec: MUS-SPEC-23-16C (docs/spec/clauses/23-mobile.md#mus-spec-23-16c)
test('swiping an approval right approves it and left declines it, and read-only rows do not swipe', async () => {
  const connection = fakeConnection({'needs.list': {needs: [need('a1', 'npm publish'), need('a2', 'rm -rf dist')]}, 'approval.respond': {}});
  const view = await render(<NeedsYouScreen connection={connection} />);
  expect(await screen.findByText('npm publish')).toBeTruthy();
  await act(async () => { swipe('swipe-a1', 260); });
  await act(async () => { swipe('swipe-a2', -260); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(connection.calls.filter(call => call.method === 'approval.respond').map(call => call.params)).toEqual([{itemId: 'a1', decision: 'accept'}, {itemId: 'a2', decision: 'decline'}]);
  await view.unmount();
  const reader = fakeConnection({'needs.list': {needs: [need('a1', 'npm publish')]}}, 'read-only');
  await render(<NeedsYouScreen connection={reader} />);
  expect(await screen.findByText('npm publish')).toBeTruthy();
  expect(() => getByGestureTestId('swipe-a1')).toThrow();
});
