import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import {DiffScreen} from '../src/screens/DiffScreen';
import {DIFF_PAGE_LINES, type MobileDiffLine, type MobileDiffPage, type MobileHunk} from '../src/shared';
import {fakeConnection} from './fake-connection';

const hash = 'a'.repeat(40);
const hunk = (id: string, fn: string, newStart: number): MobileHunk => ({id, fn, newStart, adds: 1, dels: 1, state: 'review'});
const twoHunks: MobileDiffPage = {
  runId: 'run-1', path: 'src/session/store.ts', status: 'modified', afterHash: hash, adds: 2, dels: 2,
  palette: [['#C586C0', '#AF00DB']], hunks: [hunk('h1', 'append()', 40), hunk('h2', 'read()', 55)],
  lines: [
    {k: 'c', h: 0, n: 39, old: 39, t: [['  constructor(private redis: Redis) {}']]},
    {k: 'd', h: 0, old: 40, t: [['  '], ['await', 0], [' this.redis.rpush(key(id));']], w: [[19, 24]]},
    {k: 'a', h: 0, n: 40, t: [['  '], ['return', 0], [' this.redis.xadd(streamKey(id));']], w: [[20, 24]]},
    {k: 'd', h: 1, old: 55, t: [['  const raw = await this.redis.lrange(key(id));']]},
    {k: 'a', h: 1, n: 55, t: [['  const rows = await this.redis.xrange(streamKey(id));']]},
  ],
  from: 0, total: 5, next: null,
};
const lineText = (line: MobileDiffLine) => line.t.map(([text]) => text).join('');

// Spec: MUS-SPEC-23-24O (docs/spec/clauses/23-mobile.md#mus-spec-23-24o)
test('the diff shows function-named hunks with one gutter, keeps and undoes from the toolbar and pages a 5,000-line file', async () => {
  const connection = fakeConnection({'changes.diff': twoHunks, 'changes.keep': {state: 'review'}, 'changes.undo': {stale: false}});
  const first = await render(<DiffScreen connection={connection} chatId="c1" path="src/session/store.ts" width={390} />);
  await act(async () => { fireEvent(screen.getByTestId('diff-list'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 800}}}); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(await screen.findByText('in append()')).toBeTruthy();
  expect(screen.getByText('in read()')).toBeTruthy();
  expect(screen.getByText('1 of 2')).toBeTruthy();
  const removed = screen.getByTestId('line-1'), added = screen.getByTestId('line-2');
  expect(within(removed).queryByText('40')).toBeNull();
  expect(within(added).getByText('40')).toBeTruthy();
  expect(within(added).getByText('return')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', {name: 'Keep'}));
  await act(async () => undefined);
  expect(connection.calls.filter(call => call.method === 'changes.keep').map(call => call.params)).toEqual([{chatId: 'c1', runId: 'run-1', path: 'src/session/store.ts', hunkIds: ['h1']}]);
  expect(await screen.findByText('Kept · in append()')).toBeTruthy();
  expect(screen.getByText('2 of 2')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', {name: 'Undo'}));
  await act(async () => undefined);
  expect(connection.calls.filter(call => call.method === 'changes.undo').map(call => call.params)).toEqual([{chatId: 'c1', runId: 'run-1', path: 'src/session/store.ts', afterHash: hash, hunkId: 'h2'}]);
  await fireEvent.press(screen.getByRole('button', {name: 'Previous change'}));
  expect(screen.getByText('1 of 2')).toBeTruthy();
  await first.unmount();

  const TOTAL = 5000;
  const big = (from: number): MobileDiffPage => {
    const lines: MobileDiffLine[] = Array.from({length: Math.min(DIFF_PAGE_LINES, TOTAL - from)}, (_, index) => ({k: 'a', h: 0, n: from + index + 1, t: [[`export const value${from + index} = ${from + index};`]]}));
    return {runId: 'run-1', path: 'src/big.ts', status: 'added', afterHash: hash, adds: TOTAL, dels: 0, palette: [], hunks: [{id: '*', fn: null, newStart: 1, adds: TOTAL, dels: 0, state: 'review'}], lines, from, total: TOTAL, next: from + lines.length < TOTAL ? from + lines.length : null};
  };
  const pages = fakeConnection({'changes.diff': (params: {from?: number}) => big(params.from ?? 0)});
  const started = Date.now();
  await render(<DiffScreen connection={pages} chatId="c1" path="src/big.ts" width={390} />);
  const list = screen.getByTestId('diff-list');
  await act(async () => { fireEvent(list, 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 800}}}); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(await screen.findByText('export const value0 = 0;')).toBeTruthy();
  expect(Date.now() - started).toBeLessThan(1500);
  expect(screen.queryAllByTestId(/^line-/).length).toBeLessThan(200);
  const asked = () => pages.calls.filter(call => call.method === 'changes.diff').map(call => (call.params as {from?: number}).from ?? 0);
  expect(asked()).toEqual([0]);
  for (let page = 1; page < Math.ceil(TOTAL / DIFF_PAGE_LINES); page++) {
    await act(async () => { fireEvent.scroll(list, {nativeEvent: {contentOffset: {x: 0, y: 1e7}, contentSize: {width: 390, height: 1e7 + 800}, layoutMeasurement: {width: 390, height: 800}}}); await new Promise(resolve => setTimeout(resolve, 20)); });
    await waitFor(() => expect(asked()).toHaveLength(page + 1));
  }
  expect(asked()).toEqual(Array.from({length: Math.ceil(TOTAL / DIFF_PAGE_LINES)}, (_, index) => index * DIFF_PAGE_LINES));
  expect(screen.getByLabelText('5000 of 5000 lines')).toBeTruthy();
  expect(screen.queryAllByTestId(/^line-/).length).toBeLessThan(200);
});

// Spec: MUS-SPEC-23-24P (docs/spec/clauses/23-mobile.md#mus-spec-23-24p)
test('landscape and tablet widths show the diff side by side', async () => {
  const page: MobileDiffPage = {...twoHunks, hunks: [twoHunks.hunks[0]!], lines: twoHunks.lines.slice(0, 3), total: 3};
  const narrow = await render(<DiffScreen connection={fakeConnection({'changes.diff': page})} chatId="c1" path="src/session/store.ts" width={390} />);
  await act(async () => { fireEvent(screen.getByTestId('diff-list'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 800}}}); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(await screen.findByText('in append()')).toBeTruthy();
  expect(screen.queryAllByTestId(/^split-/)).toHaveLength(0);
  await narrow.unmount();
  await render(<DiffScreen connection={fakeConnection({'changes.diff': page})} chatId="c1" path="src/session/store.ts" width={844} />);
  await act(async () => { fireEvent(screen.getByTestId('diff-list'), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 844, height: 390}}}); await new Promise(resolve => setTimeout(resolve, 50)); });
  expect(await screen.findByText('in append()')).toBeTruthy();
  const pair = screen.getByTestId('split-1');
  const [left, right] = [within(pair).getByTestId('split-left'), within(pair).getByTestId('split-right')];
  expect(within(left).getByText('40')).toBeTruthy();
  expect(within(left).getByText(lineText(page.lines[1]!).trim().split(' ')[0]!)).toBeTruthy();
  expect(within(right).getByText('return')).toBeTruthy();
  expect(within(right).getByText('40')).toBeTruthy();
});
