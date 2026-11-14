/** The phone's Noise primitives (@noble) against the desktop's (Node crypto), through the one shared Noise and channel code. */
import {randomBytes} from 'node:crypto';
import {nobleNoiseCrypto} from '../src/connection/noble-crypto';
import {Handshake, prologue, SecureChannel, type NoiseCrypto} from '../src/shared';
import {nodeNoiseCrypto} from '../../agent-app/src/runtime/mobile/node-crypto.ts';

function run(phone: NoiseCrypto, desktop: NoiseCrypto, pattern: 'IK' | 'IKpsk1', keys: {phone: ReturnType<NoiseCrypto['generateKeyPair']>; desktop: ReturnType<NoiseCrypto['generateKeyPair']>}, psk?: Uint8Array) {
  const mode = pattern === 'IK' ? 'session' : 'pair';
  const initiator = new Handshake(phone, {pattern, initiator: true, s: keys.phone, rs: keys.desktop.publicKey, ...(psk ? {psk} : {}), prologue: prologue(mode)});
  const responder = new Handshake(desktop, {pattern, initiator: false, s: keys.desktop, ...(psk ? {psk} : {}), prologue: prologue(mode)});
  const hello = responder.readMessage(initiator.writeMessage(new TextEncoder().encode('{"name":"phone"}')));
  expect(new TextDecoder().decode(hello)).toBe('{"name":"phone"}');
  expect(Buffer.from(responder.remoteStatic!)).toEqual(Buffer.from(keys.phone.publicKey));
  const welcome = initiator.readMessage(responder.writeMessage(new TextEncoder().encode('{"ok":true}')));
  expect(new TextDecoder().decode(welcome)).toBe('{"ok":true}');
  expect(Buffer.from(initiator.handshakeHash)).toEqual(Buffer.from(responder.handshakeHash));
  const p = initiator.split(), d = responder.split();
  return {phone: new SecureChannel(p.send, p.receive), desktop: new SecureChannel(d.send, d.receive)};
}

// Spec: MUS-SPEC-23-4A (docs/spec/clauses/23-mobile.md#mus-spec-23-4a)
test('the phone crypto pairs and talks with the desktop crypto', () => {
  const phone = nobleNoiseCrypto(length => new Uint8Array(randomBytes(length))), desktop = nodeNoiseCrypto();
  const keys = {phone: phone.generateKeyPair(), desktop: desktop.generateKeyPair()};
  const paired = run(phone, desktop, 'IKpsk1', keys, new Uint8Array(randomBytes(32)));
  const deliver = (from: SecureChannel, to: SecureChannel, frame: object) => { let out = null; for (const message of from.seal(frame as never)) out = to.open(message); return out; };
  expect(deliver(paired.phone, paired.desktop, {t: 'req', id: 1, m: 'chats.list', p: {}})).toEqual({t: 'req', id: 1, m: 'chats.list', p: {}});
  const big = 'x'.repeat(200_000);
  const sealed = paired.desktop.seal({t: 'res', id: 1, ok: true, r: {big}} as never);
  expect(sealed.length).toBeGreaterThan(3);
  let opened: unknown = null;
  for (const message of sealed) opened = paired.phone.open(message);
  expect(opened).toEqual({t: 'res', id: 1, ok: true, r: {big}});
  // A frame the phone sealed can't be opened as if the desktop had sent it.
  const wrong = paired.phone.seal({t: 'req', id: 2, m: 'hello', p: {}} as never)[0]!;
  expect(() => paired.phone.open(wrong)).toThrow();
  // A wrong pairing code fails on the desktop before anything is stored.
  const badPhone = new Handshake(phone, {pattern: 'IKpsk1', initiator: true, s: keys.phone, rs: keys.desktop.publicKey, psk: new Uint8Array(32).fill(1), prologue: prologue('pair')});
  const badDesktop = new Handshake(desktop, {pattern: 'IKpsk1', initiator: false, s: keys.desktop, psk: new Uint8Array(32).fill(2), prologue: prologue('pair')});
  expect(() => badDesktop.readMessage(badPhone.writeMessage())).toThrow();
  // A later session with the same static keys (plain IK) works both ways too.
  const session = run(phone, desktop, 'IK', keys);
  expect(deliver(session.desktop, session.phone, {t: 'evt', e: {type: 'access', access: 'act'}})).toEqual({t: 'evt', e: {type: 'access', access: 'act'}});
});
