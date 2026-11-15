import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import {ApprovalCard} from '../src/components/ApprovalCard';
import {fakeConnection} from './fake-connection';

const approval = {kind: 'command' as const, command: 'pnpm db:reset --seed', reason: 'Resets the local test database, then runs the spec ten times.'};

// Spec: MUS-SPEC-23-24F (docs/spec/clauses/23-mobile.md#mus-spec-23-24f)
test('an approval reads as its question, the command, one line of why and one filled Approve, and a watch-only phone is told where to answer', async () => {
  const connection = fakeConnection({'approval.respond': {}});
  const first = await render(<ApprovalCard connection={connection} itemId="a1" approval={approval} canAct fallback="" />);
  expect(screen.getByText('Run this command?')).toBeTruthy();
  expect(screen.getByText('pnpm db:reset --seed')).toBeTruthy();
  expect(screen.getByText(approval.reason)).toBeTruthy();
  expect(screen.getByText('Approving for the whole chat is a desktop setting')).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Decline'})).toBeTruthy();
  expect(screen.getAllByTestId('filled-action')).toHaveLength(1);
  (Haptics.notificationAsync as jest.Mock).mockClear();
  await fireEvent.press(screen.getByRole('button', {name: 'Approve'}));
  await waitFor(() => expect(screen.getByText(/^Approved/)).toBeTruthy());
  expect(connection.calls).toContainEqual({method: 'approval.respond', params: {itemId: 'a1', decision: 'accept'}});
  expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull();
  await first.unmount();

  await render(<ApprovalCard connection={fakeConnection({}, 'read-only')} itemId="a2" approval={approval} canAct={false} fallback="" />);
  expect(screen.getByText('Run this command?')).toBeTruthy();
  expect(screen.getByText('pnpm db:reset --seed')).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Approve'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Decline'})).toBeNull();
  expect(screen.getByText(/Answer this on Studio Mac/)).toBeTruthy();
});
