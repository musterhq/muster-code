import {act, render, screen} from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import {ComputerSwitcher} from '../src/components/ComputerSwitcher';
import {SettingsScreen} from '../src/screens/SettingsScreen';
import {PairScreen} from '../src/screens/PairScreen';
import type {ComputerView} from '../src/connection/computers';
import {createPairingStore, memorySecureStore} from '../src/connection/store';
import {formatPairingLink, type PairedRecord, type PairingLink} from '../src/shared';
import {fakeConnection} from './fake-connection';

const views: ComputerView[] = [
  {id: 'studio', name: 'Studio Mac', path: 'lan', access: 'act', connection: fakeConnection({})},
  {id: 'linux', name: 'Linux workstation', path: 'relay', access: 'read-only', connection: fakeConnection({}, 'read-only')},
];
const link: PairingLink = {relayUrl: 'wss://relay.example.com', route: 'a'.repeat(32), desktopKey: 'k'.repeat(43), code: 'c'.repeat(43), desktopName: 'Studio Mac'};
const record: PairedRecord = {relayUrl: link.relayUrl, route: link.route, desktopKey: link.desktopKey, desktopName: 'Studio Mac', deviceId: 'device-1', publicKey: 'p'.repeat(43), privateKey: 's'.repeat(43)};

// Spec: MUS-SPEC-23-24I (docs/spec/clauses/23-mobile.md#mus-spec-23-24i)
test('a watch-only computer carries an eye in the switcher and Settings, and pairing ends on the paired moment', async () => {
  const switcher = await render(<ComputerSwitcher visible computers={views} selectedId="studio" showAll={false} onSelect={() => undefined} onShowAll={() => undefined} onPair={() => undefined} onClose={() => undefined} />);
  expect(screen.getAllByLabelText('Watch only')).toHaveLength(1);
  expect(screen.queryByText('Can act')).toBeNull();
  expect(screen.queryByText('Read only')).toBeNull();
  await switcher.unmount();
  const settings = await render(<SettingsScreen computers={views} onPair={() => undefined} onUnpair={() => undefined} />);
  expect(screen.getAllByLabelText('Watch only')).toHaveLength(1);
  expect(screen.queryByText('Can act')).toBeNull();
  await settings.unmount();

  (Haptics.notificationAsync as jest.Mock).mockClear();
  const onPaired = jest.fn();
  await render(<PairScreen pairWith={async () => ({record, checkCode: '123456', confirmed: Promise.resolve()})} store={createPairingStore(memorySecureStore())} initialLink={formatPairingLink(link)} onPaired={onPaired} />);
  expect(await screen.findByText('Paired with Studio Mac')).toBeTruthy();
  expect(screen.getByText(/nobody in between/i)).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Continue'})).toBeTruthy();
  await act(async () => undefined);
  expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
});
