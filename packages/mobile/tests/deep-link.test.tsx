/** muster://pair?… opens the app on the pair screen with the link filled in, and pairing starts at once. */
import {render, screen} from '@testing-library/react-native';
import {formatPairingLink, type PairedRecord, type PairingLink} from '../src/shared';

const link: PairingLink = {relayUrl: 'wss://relay.example.com', route: 'b'.repeat(32), desktopKey: 'k'.repeat(43), code: 'c'.repeat(43), desktopName: 'Studio Mac'};
const record: PairedRecord = {relayUrl: link.relayUrl, route: link.route, desktopKey: link.desktopKey, desktopName: 'Studio Mac', deviceId: 'device-1', publicKey: 'p'.repeat(43), privateKey: 's'.repeat(43)};
const mockPair = jest.fn(async (_link: PairingLink) => ({record, checkCode: '654321', confirmed: new Promise<void>(() => undefined)}));
/** What expo-router hands the route for muster://pair?v=1&r=…: the query, decoded. */
const mockParams = Object.fromEntries(new URL(formatPairingLink(link).replace('muster://', 'https://x/')).searchParams);

jest.mock('expo-router', () => ({useLocalSearchParams: () => mockParams, useRouter: () => ({replace: jest.fn(), push: jest.fn()})}));
jest.mock('../src/connection/ConnectionProvider', () => ({useLink: () => ({pair: mockPair, store: require("../src/connection/store").createPairingStore(require("../src/connection/store").memorySecureStore()), retry: jest.fn()})}));
jest.mock('../src/components/QrScanner', () => ({QrScanner: () => null}));

// Spec: MUS-SPEC-23-14C (docs/spec/clauses/23-mobile.md#mus-spec-23-14c)
test('a muster://pair deep link fills in the link and starts pairing', async () => {
  const Pair = require('../app/pair').default;
  await render(<Pair />);
  expect(await screen.findByText('654 321')).toBeTruthy();
  expect(mockPair).toHaveBeenCalledTimes(1);
  expect(mockPair).toHaveBeenCalledWith(link);
  expect(screen.getByPlaceholderText('Pairing link').props.value).toBe(formatPairingLink(link));
});
