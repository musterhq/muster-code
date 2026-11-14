import {act, fireEvent, render, screen, within} from '@testing-library/react-native';
import {StyleSheet} from 'react-native';
import {widthClass} from '../src/layout';
import {TabletShell} from '../src/screens/TabletShell';
import type {ComputerView} from '../src/connection/computers';
import type {MobileChat} from '../src/shared';
import {fakeConnection, layOutRows, layOutTimeline} from './fake-connection';

const app = require('../app.json');
const chat: MobileChat = {id: 'c1', title: 'Migrate session store', status: 'running', updatedAt: new Date().toISOString(), place: 'atlas-api', needsYou: 0};

// Spec: MUS-SPEC-23-22A (docs/spec/clauses/23-mobile.md#mus-spec-23-22a)
test('width classes pick the layout, and an expanded window shows the sidebar, a capped chat column and the inspector', async () => {
  expect([599, 600, 839, 840].map(widthClass)).toEqual(['compact', 'medium', 'medium', 'expanded']);
  expect(app.expo.orientation).toBe('default');
  const connection = fakeConnection({'chats.list': {chats: [chat]}, 'needs.list': {needs: []}, 'chat.open': {chat, items: [{id: 'a1', kind: 'assistant', text: 'Appends now go through XADD.', createdAt: chat.updatedAt}], revision: 1, seq: 0}});
  const computers: ComputerView[] = [{id: 'studio', name: 'Studio Mac', path: 'lan', access: 'act', connection}];
  const props = {computers, selectedId: 'studio', showAll: false, onSelect: () => undefined, onShowAll: () => undefined, onPair: () => undefined};
  const view = await render(<TabletShell width={1194} {...props} />);
  await layOutTimeline('chats-list');
  const sidebar = within(screen.getByTestId('tablet-sidebar'));
  expect(await sidebar.findByText('Migrate session store')).toBeTruthy();
  expect(screen.getByTestId('inspector')).toBeTruthy();
  await layOutRows('chats-list');
  const column = screen.getByTestId('chat-column');
  expect(StyleSheet.flatten(column.props.style).maxWidth).toBe(760);
  await act(async () => { fireEvent.press(sidebar.getByRole('button', {name: /^Migrate session store/})); });
  await layOutTimeline();
  expect(await within(screen.getByTestId('chat-column')).findByText('Appends now go through XADD.')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByRole('button', {name: 'Hide sidebar'})); });
  expect(screen.queryByTestId('tablet-sidebar')).toBeNull();
  expect(screen.getByText('Appends now go through XADD.')).toBeTruthy();
  await view.rerender(<TabletShell width={390} {...props} />);
  expect(screen.queryByTestId('chat-column')).toBeNull();
  expect(screen.queryByTestId('inspector')).toBeNull();
  expect(screen.getByLabelText(/^Computer: Studio Mac, LAN/)).toBeTruthy();
});
