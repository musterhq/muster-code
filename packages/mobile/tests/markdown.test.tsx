import {act, fireEvent, render, screen} from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import {StyleSheet} from 'react-native';
import {Markdown} from '../src/components/Markdown';
import {setRenderProbe} from '../src/perf';

const mockProps: Array<Record<string, unknown>> = [];
jest.mock('react-native-enriched-markdown', () => {
  const real = require('react-native-enriched-markdown/jest');
  return {...real, EnrichedMarkdownText: (props: Record<string, unknown>) => { mockProps.push(props); return real.EnrichedMarkdownText(props); }};
});
jest.mock('expo-clipboard', () => ({setStringAsync: jest.fn(async () => true)}));
afterEach(() => { setRenderProbe(null); mockProps.length = 0; });

const reply = [
  '## How replay works', '', 'Consumers read with a group cursor; size is $s \\cdot k$.', '',
  '| Algorithm | p99 |', '|---|---|', '| Token bucket | 1.9 ms |', '', '- [x] Lua script', '- [ ] Per-key overrides', '',
  '```ts', 'const tokens = 10;', 'return tokens;', '```', '',
  '```mermaid', 'graph LR', '  A[API] --> B[XADD stream]', '```', '',
  '```vega-lite', '{"mark": "line"}', '```',
].join('\n');

// Spec: MUS-SPEC-23-21A (docs/spec/clauses/23-mobile.md#mus-spec-23-21a)
test('a reply renders prose as Markdown, code with line numbers and Copy, and diagrams as cards that open full screen', async () => {
  await render(<Markdown text={reply} />);
  const prose = mockProps.map(props => props.markdown as string).join('\n');
  expect(prose).toContain('## How replay works');
  expect(prose).toContain('| Token bucket | 1.9 ms |');
  expect(prose).toContain('- [ ] Per-key overrides');
  expect(prose).toContain('$s \\cdot k$');
  expect(prose).not.toContain('const tokens');
  expect(mockProps.every(props => props.flavor === 'github')).toBe(true);
  expect(screen.getByText('ts')).toBeTruthy();
  expect(screen.getByText('const tokens = 10;')).toBeTruthy();
  expect(screen.getByText('1')).toBeTruthy();
  expect(screen.getByText('2')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByRole('button', {name: 'Copy code'})); });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith('const tokens = 10;\nreturn tokens;');
  expect(screen.getByText('Copied')).toBeTruthy();
  expect(Haptics.impactAsync).toHaveBeenCalled();
  const diagram = screen.getByRole('button', {name: 'Diagram, open full screen'});
  const chart = screen.getByRole('button', {name: 'Chart, open full screen'});
  for (const card of [diagram, chart]) expect(StyleSheet.flatten(card.props.style).height).toBeGreaterThanOrEqual(160);
  await act(async () => { fireEvent.press(diagram); });
  expect(screen.getByTestId('rich-full-screen')).toBeTruthy();
  expect(screen.getAllByText(/A\[API\] --> B\[XADD stream\]/).length).toBeGreaterThan(0);
});

// Spec: MUS-SPEC-23-21B (docs/spec/clauses/23-mobile.md#mus-spec-23-21b)
test('while a reply streams only its last block re-renders, and an unclosed fence shows as code', async () => {
  const renders = new Map<string, number>();
  setRenderProbe((name, id) => { if (name === 'md-block') renders.set(id, (renders.get(id) ?? 0) + 1); });
  let text = 'Migration script is in place.\n\n```sql\nSELECT 1;';
  const view = await render(<Markdown text={text} />);
  expect(screen.getByText('SELECT 1;')).toBeTruthy();
  renders.clear();
  for (const line of ['SELECT 2;', 'SELECT 3;']) { text += `\n${line}`; await view.rerender(<Markdown text={text} />); }
  expect(screen.getByText('SELECT 3;')).toBeTruthy();
  expect(renders.get('0')).toBeUndefined();
  expect(renders.get('1')).toBe(2);
  text += '\n```\n\nNow writing the migration.';
  await view.rerender(<Markdown text={text} />);
  expect(screen.getByText('SELECT 3;')).toBeTruthy();
  expect(mockProps.at(-1)!.markdown).toBe('Now writing the migration.');
  expect(renders.get('0')).toBeUndefined();
});
