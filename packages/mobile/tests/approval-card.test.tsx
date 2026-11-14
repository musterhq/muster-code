import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {StyleSheet} from 'react-native';
import * as Haptics from 'expo-haptics';
import {ApprovalCard} from '../src/components/ApprovalCard';
import {MobileError} from '../src/shared';
import {fakeConnection} from './fake-connection';

const button = (label: string) => { let node: any = screen.getByText(label); while (node && node.props.accessibilityRole !== 'button') node = node.parent; return node; };

// Spec: MUS-SPEC-23-16B (docs/spec/clauses/23-mobile.md#mus-spec-23-16b)
test('approve is sent once, settles to Approved with a haptic, and a failure brings the buttons back', async () => {
  let release: () => void = () => undefined;
  const connection = fakeConnection({'approval.respond': () => new Promise<object>(resolve => { release = () => resolve({}); })});
  const view = await render(<ApprovalCard connection={connection} itemId="a1" approval={{kind: 'command', command: 'npm publish'}} canAct fallback="" />);
  for (const label of ['Approve', 'Decline']) expect((StyleSheet.flatten(button(label).props.style) as {minHeight?: number}).minHeight).toBeGreaterThanOrEqual(44);
  await fireEvent.press(screen.getByText('Approve'));
  await fireEvent.press(screen.getByText('Approve'));
  expect(connection.calls.filter(call => call.method === 'approval.respond')).toEqual([{method: 'approval.respond', params: {itemId: 'a1', decision: 'accept'}}]);
  expect(button('Approve').props.accessibilityState.disabled).toBe(true);
  expect(button('Decline').props.accessibilityState.disabled).toBe(true);
  await act(async () => { release(); });
  expect(await screen.findByText('Approved')).toBeTruthy();
  expect(screen.queryByText('Approve')).toBeNull();
  expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  await view.unmount();

  const declining = fakeConnection({'approval.respond': {}});
  const second = await render(<ApprovalCard connection={declining} itemId="a2" approval={{kind: 'command', command: 'rm -rf build'}} canAct fallback="" />);
  await fireEvent.press(screen.getByText('Decline'));
  expect(await screen.findByText('Declined')).toBeTruthy();
  expect(declining.calls.find(call => call.method === 'approval.respond')?.params).toEqual({itemId: 'a2', decision: 'decline'});
  expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);
  await second.unmount();

  const failing = fakeConnection({'approval.respond': () => Promise.reject(new MobileError('read-only', 'This phone is read only.'))});
  await render(<ApprovalCard connection={failing} itemId="a3" approval={{kind: 'command', command: 'make'}} canAct fallback="" />);
  await fireEvent.press(screen.getByText('Approve'));
  expect(await screen.findByText('This phone is read only.')).toBeTruthy();
  expect(button('Approve').props.accessibilityState.disabled).toBe(false);
});
