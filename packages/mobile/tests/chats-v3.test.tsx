import {act, render, screen} from '@testing-library/react-native';
import {StyleSheet} from 'react-native';
import * as Haptics from 'expo-haptics';
import {ChatsScreen} from '../src/screens/ChatsScreen';
import type {MobileChat} from '../src/shared';
import {fakeConnection, layOutTimeline} from './fake-connection';

const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const chats: MobileChat[] = [
  {id: 'run', title: 'Migrate session store to Streams', status: 'running', updatedAt: minutes(0), place: 'atlas-api', needsYou: 0},
  {id: 'wait', title: 'Fix flaky checkout test', status: 'waiting', updatedAt: minutes(2), place: 'atlas-web', needsYou: 1},
  {id: 'fail', title: 'Nightly ETL out of memory', status: 'failed', updatedAt: minutes(180), place: null, needsYou: 0},
  {id: 'done', title: 'Bump React Native to 0.88', status: 'completed', updatedAt: minutes(60), place: 'atlas-api', needsYou: 0},
];
/** The section headers and rows in screen order (by where the list placed them), as a reader would meet them. */
const topOf = (node: any) => StyleSheet.flatten(node.parent?.props.style)?.top ?? 0;
const outline = () => screen.getByTestId('chats-list').queryAll(node => typeof node.type === 'string' && (node.props.accessibilityRole === 'header' || node.props.testID?.startsWith?.('chat-row-')))
  .sort((a, b) => topOf(a) - topOf(b))
  .map(node => node.props.accessibilityRole === 'header' ? `# ${node.props.accessibilityLabel}` : node.props.testID.slice('chat-row-'.length));

// Spec: MUS-SPEC-23-24B (docs/spec/clauses/23-mobile.md#mus-spec-23-24b)
test('chats show as two-line rows in Active and Earlier, and a chat that starts running moves into Active with a tick', async () => {
  const connection = fakeConnection({'chats.list': {chats}});
  await render(<ChatsScreen connection={connection} onOpen={() => undefined} />);
  await layOutTimeline('chats-list');
  await screen.findByText('Migrate session store to Streams');
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  expect(outline()).toEqual(['# Active', 'run', 'wait', '# Earlier', 'done', 'fail']);
  expect(screen.getByLabelText(/^Fix flaky checkout test, Needs you/)).toBeTruthy();
  expect(screen.getByLabelText(/^Nightly ETL out of memory, Failed/)).toBeTruthy();
  expect(screen.getByLabelText(/^Migrate session store to Streams, Running/)).toBeTruthy();
  expect(screen.getByText('Needs you')).toBeTruthy();
  (Haptics.selectionAsync as jest.Mock).mockClear();
  await act(async () => { connection.emit({type: 'chats', chats: chats.map(chat => chat.id === 'done' ? {...chat, status: 'running', updatedAt: minutes(0)} : chat)}); });
  await layOutTimeline('chats-list');
  expect(outline().slice(0, 4)).toEqual(['# Active', 'done', 'run', 'wait']);
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
});
