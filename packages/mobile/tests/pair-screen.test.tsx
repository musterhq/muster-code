import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import {PairScreen} from '../src/screens/PairScreen';
import {createPairingStore, memorySecureStore} from '../src/connection/store';
import {formatPairingLink, type PairedRecord, type PairingLink} from '../src/shared';

const link: PairingLink = {relayUrl: 'wss://relay.example.com', route: 'a'.repeat(32), desktopKey: 'k'.repeat(43), code: 'c'.repeat(43), desktopName: 'Studio Mac'};
const record: PairedRecord = {relayUrl: link.relayUrl, route: link.route, desktopKey: link.desktopKey, desktopName: 'Studio Mac', deviceId: 'device-1', publicKey: 'p'.repeat(43), privateKey: 's'.repeat(43)};

// Spec: MUS-SPEC-23-4B (docs/spec/clauses/23-mobile.md#mus-spec-23-4b)
test('pairs from a pasted link and rejects a malformed one', async () => {
  const store = createPairingStore(memorySecureStore());
  let confirm = () => {};
  const confirmed = new Promise<void>(resolve => { confirm = resolve; });
  const pairWith = jest.fn(async (_link: PairingLink) => ({record, checkCode: '123456', confirmed}));
  const onPaired = jest.fn();
  await render(<PairScreen pairWith={pairWith} store={store} onPaired={onPaired} />);
  await fireEvent.changeText(screen.getByPlaceholderText('Pairing link'), 'hello');
  await fireEvent.press(screen.getByText('Pair'));
  expect(await screen.findByText(/This is not a Muster pairing link/)).toBeTruthy();
  expect(pairWith).not.toHaveBeenCalled();
  expect(await store.load()).toBeNull();
  await fireEvent.changeText(screen.getByPlaceholderText('Pairing link'), formatPairingLink(link));
  await fireEvent.press(screen.getByText('Pair'));
  expect(await screen.findByText('123 456')).toBeTruthy();
  expect(screen.getByText(/confirm it on your computer/i)).toBeTruthy();
  expect(pairWith).toHaveBeenCalledWith(link);
  expect(await store.load()).toBeNull();
  await act(async () => { confirm(); });
  expect(await screen.findByText('Paired with Studio Mac')).toBeTruthy();
  await waitFor(async () => expect(await store.load()).toEqual(record));
  expect(onPaired).toHaveBeenCalledWith(record);
});

// Spec: MUS-SPEC-23-14A (docs/spec/clauses/23-mobile.md#mus-spec-23-14a)
test('a second scan or Pair press while pairing is in flight is ignored and never hides the check code', async () => {
  const store = createPairingStore(memorySecureStore());
  const text = formatPairingLink(link);
  let answer = (_value: {record: PairedRecord; checkCode: string; confirmed: Promise<void>}) => {};
  let fail = (_error: Error) => {};
  const confirmed = new Promise<void>((_resolve, reject) => { fail = reject; });
  confirmed.catch(() => undefined);
  // The first attempt waits on the network; any later attempt would be told the code was already used.
  const pairWith = jest.fn()
    .mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }))
    .mockImplementation(async () => { throw new Error('This pairing code was already used by another phone.'); });
  const {Text} = require('react-native');
  await render(<PairScreen pairWith={pairWith} store={store} scanner={onScan => <Text onPress={() => onScan(text)}>Fake scanner</Text>} />);
  // The camera scans the QR and pairing starts; the person also presses Pair with the same link before it answers.
  await fireEvent.press(screen.getByText('Fake scanner'));
  expect(screen.queryByText('Fake scanner')).toBeNull();
  expect(screen.getByPlaceholderText('Pairing link').props.editable).toBe(false);
  await fireEvent.press(screen.getByText('Pairing…'));
  await act(async () => { answer({record, checkCode: '123456', confirmed}); });
  expect(await screen.findByText('123 456')).toBeTruthy();
  // Pressing again while the desktop waits for the owner changes nothing.
  await fireEvent.press(screen.getByText('Pairing…'));
  await act(async () => undefined);
  expect(pairWith).toHaveBeenCalledTimes(1);
  expect(screen.getByText('123 456')).toBeTruthy();
  expect(screen.queryByText(/already used/)).toBeNull();
  expect(await store.load()).toBeNull();
  // When the attempt itself ends (rejected on the computer), its error shows and pairing can start again.
  await act(async () => { fail(new Error('Pairing was rejected on your computer.')); });
  expect(await screen.findByText('Pairing was rejected on your computer.')).toBeTruthy();
  expect(screen.queryByText('123 456')).toBeNull();
  expect(screen.getByText('Fake scanner')).toBeTruthy();
  expect(screen.getByText('Pair')).toBeTruthy();
});
