import {useState} from 'react';
import {act, fireEvent, render, screen, within} from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import {createComputerStore, memorySecureStore} from '../src/connection/store';
import {ChatsHome} from '../src/screens/ChatsHome';
import type {ComputerView} from '../src/connection/computers';
import type {MobileChat, PairedRecord} from '../src/shared';
import {fakeConnection, layOutTimeline} from './fake-connection';

const record = (name: string, route: string, key: string): PairedRecord => ({relayUrl: 'wss://relay.example', route, desktopKey: `desk-${key}`, desktopName: name, deviceId: `dev-${key}`, publicKey: `pub-${key}`, privateKey: `priv-${key}`});
const chat = (id: string, title: string): MobileChat => ({id, title, status: 'idle', updatedAt: new Date().toISOString(), place: 'atlas-api', needsYou: 0});

// Spec: MUS-SPEC-23-19A (docs/spec/clauses/23-mobile.md#mus-spec-23-19a)
test('two computers are paired side by side, the switcher shows each one’s status, and Chats shows one computer or all', async () => {
  const secure = memorySecureStore();
  const store = createComputerStore(secure);
  const studio = record('Studio Mac', 'a'.repeat(32), 'studio'), build = record('Build box', 'b'.repeat(32), 'build');
  await store.save(studio);
  await store.save(build);
  // A fresh store over the same secure storage reads both, each with its own keys.
  const listed = await createComputerStore(secure).list();
  expect(listed).toEqual([studio, build]);
  expect(new Set(listed.map(entry => entry.privateKey)).size).toBe(2);

  const views: ComputerView[] = [
    {id: studio.route, name: 'Studio Mac', path: 'lan', access: 'act', connection: fakeConnection({'chats.list': {chats: [chat('s1', 'Migrate session store')]}})},
    {id: build.route, name: 'Build box', path: 'relay', access: 'read-only', connection: fakeConnection({'chats.list': {chats: [chat('b1', 'Nightly ETL runs out of memory')]}}, 'read-only')},
  ];
  function Harness() {
    const [selected, setSelected] = useState(studio.route);
    const [all, setAll] = useState(false);
    return <ChatsHome computers={views} selectedId={selected} showAll={all} onSelect={setSelected} onShowAll={setAll} onPair={() => undefined} onOpen={() => undefined} />;
  }
  await render(<Harness />);
  await layOutTimeline('chats-list');
  expect(await screen.findByText('Migrate session store')).toBeTruthy();
  expect(screen.queryByText('Nightly ETL runs out of memory')).toBeNull();
  const pill = screen.getByLabelText(/^Computer: Studio Mac, LAN/);
  await act(async () => { fireEvent.press(pill); });
  const sheet = within(screen.getByTestId('computer-switcher'));
  expect(sheet.getByText('Studio Mac')).toBeTruthy();
  expect(sheet.getByText(/Connected · LAN direct/)).toBeTruthy();
  expect(sheet.getByText(/Connected · Relay/)).toBeTruthy();
  expect(sheet.getByText('Can act')).toBeTruthy();
  expect(sheet.getByText('Read only')).toBeTruthy();
  expect(sheet.getByText('Pair another computer')).toBeTruthy();
  await act(async () => { fireEvent.press(sheet.getByLabelText('Build box')); });
  await layOutTimeline('chats-list');
  expect(await screen.findByText('Nightly ETL runs out of memory')).toBeTruthy();
  expect(screen.queryByText('Migrate session store')).toBeNull();
  expect(screen.getByLabelText(/^Computer: Build box, Relay/)).toBeTruthy();
  expect(Haptics.selectionAsync).toHaveBeenCalled();
  // Show all computers together: both lists, each row naming its computer.
  await act(async () => { fireEvent.press(screen.getByLabelText(/^Computer: Build box/)); });
  await act(async () => { fireEvent(within(screen.getByTestId('computer-switcher')).getByRole('switch'), 'valueChange', true); });
  await layOutTimeline('chats-list');
  expect(await screen.findByText('Migrate session store')).toBeTruthy();
  expect(screen.getByText('Nightly ETL runs out of memory')).toBeTruthy();
  expect(screen.getByText(/^Studio Mac · atlas-api/)).toBeTruthy();
  expect(screen.getByText(/^Build box · atlas-api/)).toBeTruthy();
  // Removing one computer leaves the other's record and keys as they were.
  await store.remove(studio.route);
  expect(await createComputerStore(secure).list()).toEqual([build]);
});
