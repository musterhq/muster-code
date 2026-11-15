import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {TerminalScreen} from '../src/screens/TerminalScreen';
import {fakeConnection} from './fake-connection';

const answers = {
  'terminal.list': {terminals: [{id: 't1', title: 'dev server', running: true}, {id: 't2', title: 'zsh', running: true}]},
  'terminal.open': (params: {id: string}) => ({text: params.id === 't1' ? '\u001b[32m✓\u001b[0m redis connected 127.0.0.1:6379\n' : 'zsh ready\n', running: true}),
};
const inputs = (connection: ReturnType<typeof fakeConnection>) => connection.calls.filter(call => call.method === 'terminal.input').map(call => (call.params as {data: string}).data);

// Spec: MUS-SPEC-23-25N (docs/spec/clauses/23-mobile.md#mus-spec-23-25n)
test('the terminal shows live output in tabs and sends keys with a ctrl latch, and only watches when read only', async () => {
  const connection = fakeConnection(answers);
  const view = await render(<TerminalScreen connection={connection} chatId="c1" />);
  expect(await screen.findByRole('tab', {name: 'dev server'})).toBeTruthy();
  expect(screen.getByRole('tab', {name: 'zsh'})).toBeTruthy();
  expect(screen.getByRole('tab', {name: 'dev server'}).props.accessibilityState).toMatchObject({selected: true});
  expect(await screen.findByText(/✓ redis connected 127\.0\.0\.1:6379/)).toBeTruthy();
  await act(async () => { connection.emit({type: 'terminal', id: 't1', data: '14:31:02 POST /v1/sessions 201\n'}); await new Promise(resolve => setTimeout(resolve, 80)); });
  expect(screen.getByText(/POST \/v1\/sessions 201/)).toBeTruthy();
  expect(screen.queryByText(/\u001b/)).toBeNull();

  await fireEvent.press(screen.getByRole('button', {name: 'ctrl'}));
  expect(screen.getByRole('button', {name: 'ctrl'}).props.accessibilityState).toMatchObject({selected: true});
  await fireEvent.changeText(screen.getByLabelText('Terminal input'), 'c');
  await fireEvent.press(screen.getByRole('button', {name: 'tab'}));
  await fireEvent.press(screen.getByRole('button', {name: 'up'}));
  await fireEvent.changeText(screen.getByLabelText('Terminal input'), 'ls');
  await fireEvent(screen.getByLabelText('Terminal input'), 'submitEditing');
  await act(async () => undefined);
  expect(inputs(connection)).toEqual(['\u0003', '\t', '\u001b[A', 'ls\r']);
  expect(screen.getByRole('button', {name: 'ctrl'}).props.accessibilityState).toMatchObject({selected: false});
  await fireEvent.press(screen.getByRole('tab', {name: 'zsh'}));
  await act(async () => undefined);
  expect(connection.calls.filter(call => call.method === 'terminal.open').map(call => call.params)).toEqual([{chatId: 'c1', id: 't1'}, {chatId: 'c1', id: 't2'}]);
  await view.unmount();

  const reader = fakeConnection(answers, 'read-only');
  await render(<TerminalScreen connection={reader} chatId="c1" />);
  expect(await screen.findByText(/redis connected/)).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'ctrl'})).toBeNull();
  expect(screen.queryByLabelText('Terminal input')).toBeNull();
});
