import {render, screen} from '@testing-library/react-native';
import {StyleSheet} from 'react-native';
import * as ReactNative from 'react-native';
import {ChatsScreen} from '../src/screens/ChatsScreen';
import type {MobileChat} from '../src/shared';
import {fakeConnection, layOutTimeline} from './fake-connection';

const at = new Date().toISOString();
const chats: MobileChat[] = [
  {id: 'c1', title: 'Mobile app phase 3', status: 'running', updatedAt: at, place: 'muster-code', needsYou: 0},
  {id: 'c2', title: 'Release checklist', status: 'waiting', updatedAt: at, place: 'muster-code', needsYou: 2},
];
const color = (node: any, key: 'color' | 'backgroundColor') => { for (let at = node; at; at = at.parent) { const value = at.props?.style ? (StyleSheet.flatten(at.props.style) as Record<string, string>)[key] : undefined; if (value) return value; } return undefined; };

// Spec: MUS-SPEC-23-16D (docs/spec/clauses/23-mobile.md#mus-spec-23-16d)
test('the chats screen follows the phone’s light or dark setting', async () => {
  const scheme = jest.spyOn(ReactNative, 'useColorScheme');
  scheme.mockReturnValue('light');
  const light = await render(<ChatsScreen connection={fakeConnection({'chats.list': {chats}})} onOpen={() => undefined} />);
  await layOutTimeline('chats-list');
  const title = await screen.findByText('Mobile app phase 3');
  expect(color(title.parent, 'backgroundColor')).toBe('#fbfbfb');
  expect(['#000000', '#1d1d1f']).toContain(color(title, 'color'));
  expect(screen.getByText(/muster-code · Working/)).toBeTruthy();
  expect(screen.getByLabelText('2 waiting on you')).toBeTruthy();
  await light.unmount();
  scheme.mockReturnValue('dark');
  await render(<ChatsScreen connection={fakeConnection({'chats.list': {chats}})} onOpen={() => undefined} />);
  await layOutTimeline('chats-list');
  const dark = await screen.findByText('Mobile app phase 3');
  expect(color(dark.parent, 'backgroundColor')).toBe('#0e0e0e');
  expect(['#ffffff', '#e8e8e8']).toContain(color(dark, 'color'));
  scheme.mockRestore();
});
