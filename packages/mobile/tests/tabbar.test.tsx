import {fireEvent, render, screen} from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import {GlassTabBar} from '../src/components/GlassTabBar';
import {ChatsScreen} from '../src/screens/ChatsScreen';
import type {MobileChat} from '../src/shared';
import {fakeConnection, layOutTimeline} from './fake-connection';

// Spec: MUS-SPEC-23-24H (docs/spec/clauses/23-mobile.md#mus-spec-23-24h)
test('the glass tab bar shows four tabs and the Needs you count, with search as its own circle', async () => {
  const onTab = jest.fn(), onSearch = jest.fn();
  await render(<GlassTabBar active="index" needs={2} onTab={onTab} onSearch={onSearch} />);
  expect(screen.getAllByRole('tab').map(tab => tab.props.accessibilityLabel)).toEqual(['Chats', 'Needs you, 2 waiting', 'Projects', 'Settings']);
  expect(screen.getByRole('tab', {name: 'Chats'}).props.accessibilityState).toMatchObject({selected: true});
  expect(screen.getByText('2')).toBeTruthy();
  (Haptics.selectionAsync as jest.Mock).mockClear();
  await fireEvent.press(screen.getByRole('tab', {name: /^Needs you/}));
  expect(onTab).toHaveBeenCalledWith('needs-you');
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  const search = screen.getByRole('button', {name: 'Search'});
  expect(screen.getAllByRole('tab')).not.toContain(search);
  await fireEvent.press(search);
  expect(onSearch).toHaveBeenCalled();

  const at = new Date().toISOString();
  const chats: MobileChat[] = [{id: 'a', title: 'Migrate session store', status: 'idle', updatedAt: at, place: null, needsYou: 0}, {id: 'b', title: 'Dark mode', status: 'idle', updatedAt: at, place: null, needsYou: 0}];
  await render(<ChatsScreen connection={fakeConnection({'chats.list': {chats}})} searching onOpen={() => undefined} />);
  await layOutTimeline('chats-list');
  await fireEvent.changeText(screen.getByPlaceholderText('Search chats'), 'dark');
  await layOutTimeline('chats-list');
  expect(screen.getByText('Dark mode')).toBeTruthy();
  expect(screen.queryByText('Migrate session store')).toBeNull();
});
