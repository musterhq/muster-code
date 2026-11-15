import {act, fireEvent, render, screen} from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import {NeedsYouScreen} from '../src/screens/NeedsYouScreen';
import type {MobileNeed} from '../src/shared';
import {fakeConnection} from './fake-connection';

const need: MobileNeed = {chatId: 'c1', chatTitle: 'Fix flaky checkout test', itemId: 'a1', kind: 'approval', summary: 'pnpm db:reset', createdAt: new Date().toISOString(), approval: {kind: 'command', command: 'pnpm db:reset'}};

// Spec: MUS-SPEC-23-24G (docs/spec/clauses/23-mobile.md#mus-spec-23-24g)
test('answering the last request shows All clear with one success haptic', async () => {
  const connection = fakeConnection({'needs.list': {needs: [need]}, 'approval.respond': {}});
  await render(<NeedsYouScreen connection={connection} />);
  expect(await screen.findByText('1 waiting')).toBeTruthy();
  (Haptics.notificationAsync as jest.Mock).mockClear();
  await fireEvent.press(screen.getByRole('button', {name: 'Approve'}));
  await act(async () => { connection.emit({type: 'needs', needs: []}); });
  expect(await screen.findByText('All clear')).toBeTruthy();
  expect(screen.getByText('Just answered')).toBeTruthy();
  expect(screen.getByText('Approved pnpm db:reset')).toBeTruthy();
  expect((Haptics.notificationAsync as jest.Mock).mock.calls.filter(([kind]) => kind === 'success')).toHaveLength(1);
});
