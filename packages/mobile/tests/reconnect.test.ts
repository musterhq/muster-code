/** What the app does after its link fails or closes: retry with backoff, or show the phone as revoked (only on 4403). */
import {randomBytes} from 'node:crypto';
import {afterLinkClose, afterLinkFailure} from '../src/connection/reconnect';
import {nobleNoiseCrypto} from '../src/connection/noble-crypto';
import {connectPhone, toBase64Url, type PairedRecord, type SocketLike} from '../src/shared';

const crypto = nobleNoiseCrypto(length => new Uint8Array(randomBytes(length)));
const key = () => toBase64Url(crypto.generateKeyPair().publicKey);
const record: PairedRecord = {relayUrl: 'wss://relay.example.com', route: 'a'.repeat(32), desktopKey: key(), desktopName: 'Studio', deviceId: 'd1', publicKey: key(), privateKey: toBase64Url(new Uint8Array(randomBytes(32)))};
/** A socket whose far end closes with `code` as soon as the first handshake message arrives. */
const closingWith = (code: number, reason: string) => (): SocketLike => {
  const socket: SocketLike = {onopen: null, onmessage: null, onclose: null, onerror: null,
    send() { setTimeout(() => socket.onclose?.({code, reason}), 0); }, close() {}};
  setTimeout(() => socket.onopen?.({}), 0);
  return socket;
};
const failure = async (code: number, reason: string) => connectPhone({record, crypto, socket: closingWith(code, reason)}).then(() => { throw new Error('expected a failure'); }, error => error);

// Spec: MUS-SPEC-23-9B (docs/spec/clauses/23-mobile.md#mus-spec-23-9b)
test('a 4400 close retries and only 4403 shows the phone as revoked', async () => {
  expect(afterLinkFailure(await failure(4400, 'bad frame'))).toBe('retry');
  expect(afterLinkFailure(await failure(4404, 'offline'))).toBe('retry');
  expect(afterLinkFailure(await failure(4403, 'revoked'))).toBe('revoked');
  expect(afterLinkClose('bad frame')).toBe('retry');
  expect(afterLinkClose('closed')).toBe('retry');
  expect(afterLinkClose('revoked')).toBe('revoked');
});
