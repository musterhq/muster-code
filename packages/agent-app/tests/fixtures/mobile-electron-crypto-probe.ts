// Run by mobile-326.test.ts inside Electron's own Node (ELECTRON_RUN_AS_NODE): the desktop's Noise crypto must work on
// Electron's BoringSSL, not only on Node's OpenSSL (#326). Prints one JSON line.
import {nodeNoiseCrypto} from '../../src/runtime/mobile/node-crypto.ts';
import {Handshake} from '../../src/shared/mobile/noise.ts';
import {prologue} from '../../src/shared/mobile/channel.ts';
import {utf8, fromUtf8} from '../../src/shared/mobile/bytes.ts';

const result: Record<string, unknown> = {runtime: process.versions.electron ?? 'node'};
try {
  const crypto = nodeNoiseCrypto();
  const desktop = crypto.generateKeyPair(), phone = crypto.generateKeyPair(), code = crypto.randomBytes(32);
  const initiator = new Handshake(crypto, {pattern: 'IKpsk1', initiator: true, s: phone, rs: desktop.publicKey, psk: code, prologue: prologue('pair')});
  const responder = new Handshake(crypto, {pattern: 'IKpsk1', initiator: false, s: desktop, psk: code, prologue: prologue('pair')});
  result.request = fromUtf8(responder.readMessage(initiator.writeMessage(utf8('pair me'))));
  result.welcome = fromUtf8(initiator.readMessage(responder.writeMessage(utf8('welcome'))));
  const nonce = new Uint8Array(12), key = crypto.randomBytes(32), ad = utf8('ad');
  result.transport = fromUtf8(crypto.decrypt(key, nonce, ad, crypto.encrypt(key, nonce, ad, utf8('frame'))));
  result.ok = true;
} catch (error) { result.ok = false; result.error = (error as Error).message; }
console.log(JSON.stringify(result));
