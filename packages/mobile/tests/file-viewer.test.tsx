import {act, fireEvent, render, screen, within} from '@testing-library/react-native';
import {FileViewer} from '../src/screens/FileViewer';
import type {MobileFilePage} from '../src/shared';
import {fakeConnection} from './fake-connection';

const page = (query?: string): MobileFilePage => ({path: 'src/session/store.ts', change: 'modified', palette: [['#C586C0', '#AF00DB']],
  lines: [[['import', 0], [" { Redis } from 'ioredis';"]], [['  return this.redis.xadd(key);']], [['  await this.redis.xadd(other);']]],
  from: 0, total: 3, next: null, ...(query ? {matches: [1, 2]} : {})});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

// Spec: MUS-SPEC-23-25E (docs/spec/clauses/23-mobile.md#mus-spec-23-25e)
test('the file viewer numbers lines, finds with a count, wraps, sizes text and opens the diff or the chat', async () => {
  const connection = fakeConnection({'files.read': (params: {query?: string}) => page(params.query)});
  const diffs: string[] = [], asks: string[] = [];
  const view = await render(<FileViewer connection={connection} chatId="c1" path="src/session/store.ts" onShowDiff={path => diffs.push(path)} onAsk={path => asks.push(path)} />);
  await act(async () => { fireEvent(screen.getByTestId('file-list'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 800}}}); });
  await settle();
  expect(within(screen.getByTestId('file-line-0')).getByText('1')).toBeTruthy();
  expect(within(screen.getByTestId('file-line-2')).getByText('3')).toBeTruthy();
  expect(screen.getByText('import')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Find in file'), 'xadd');
  await fireEvent(screen.getByLabelText('Find in file'), 'submitEditing');
  await settle();
  expect(connection.calls.filter(call => call.method === 'files.read').map(call => call.params)).toContainEqual({chatId: 'c1', path: 'src/session/store.ts', query: 'xadd'});
  expect(screen.getByText('1 of 2')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', {name: 'Next match'}));
  expect(screen.getByText('2 of 2')).toBeTruthy();
  const code = () => screen.getByTestId('file-code-1');
  const sizeOf = () => [code().props.style].flat(5).reduce((size: number | undefined, style: {fontSize?: number} | undefined) => style?.fontSize ?? size, undefined);
  const before = sizeOf();
  await fireEvent.press(screen.getByRole('button', {name: 'Larger text'}));
  expect(sizeOf()).toBe((before ?? 13) + 1);
  expect(screen.getByRole('button', {name: 'Wrap lines'}).props.accessibilityState).toMatchObject({selected: true});
  await fireEvent.press(screen.getByRole('button', {name: 'Wrap lines'}));
  expect(screen.getByRole('button', {name: 'Wrap lines'}).props.accessibilityState).toMatchObject({selected: false});
  await fireEvent.press(screen.getByRole('button', {name: 'Show diff'}));
  await fireEvent.press(screen.getByRole('button', {name: 'Ask about this'}));
  expect(diffs).toEqual(['src/session/store.ts']);
  expect(asks).toEqual(['src/session/store.ts']);
  await view.unmount();

  const binary = fakeConnection({'files.read': {path: 'logo.png', binary: true, palette: [], lines: [], from: 0, total: 0, next: null}});
  await render(<FileViewer connection={binary} chatId="c1" path="logo.png" />);
  expect(await screen.findByText('This file can’t be shown here. Open it on Studio Mac.')).toBeTruthy();
  expect(screen.queryByTestId('file-line-0')).toBeNull();
});
