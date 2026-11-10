import {fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import {PairScreen} from '../src/screens/PairScreen';
import {createPairingStore, memorySecureStore} from '../src/connection/store';
import {formatPairingLink, type PairedRecord, type PairingLink} from '../src/shared';

const link: PairingLink = {relayUrl: 'wss://relay.example.com', route: 'a'.repeat(32), desktopKey: 'k'.repeat(43), code: 'c'.repeat(43), desktopName: 'Studio Mac'};
const record: PairedRecord = {relayUrl: link.relayUrl, route: link.route, desktopKey: link.desktopKey, desktopName: 'Studio Mac', deviceId: 'device-1', publicKey: 'p'.repeat(43), privateKey: 's'.repeat(43)};

// Spec: MUS-SPEC-23-4B (docs/spec/clauses/23-mobile.md#mus-spec-23-4b)
test('pairs from a pasted link and rejects a malformed one', async () => {
  const store = createPairingStore(memorySecureStore());
  const pairWith = jest.fn(async (_link: PairingLink) => record);
  const onPaired = jest.fn();
  await render(<PairScreen pairWith={pairWith} store={store} onPaired={onPaired} />);
  await fireEvent.changeText(screen.getByPlaceholderText('Pairing link'), 'hello');
  await fireEvent.press(screen.getByText('Pair'));
  expect(await screen.findByText(/This is not a Muster pairing link/)).toBeTruthy();
  expect(pairWith).not.toHaveBeenCalled();
  expect(await store.load()).toBeNull();
  await fireEvent.changeText(screen.getByPlaceholderText('Pairing link'), formatPairingLink(link));
  await fireEvent.press(screen.getByText('Pair'));
  expect(await screen.findByText('Paired with Studio Mac')).toBeTruthy();
  expect(pairWith).toHaveBeenCalledWith(link);
  await waitFor(async () => expect(await store.load()).toEqual(record));
  expect(onPaired).toHaveBeenCalledWith(record);
});
