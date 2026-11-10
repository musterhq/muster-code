/**
 * Noise Protocol Framework (revision 34), the two patterns the phone link uses (#326, docs/mobile/DESIGN.md §3):
 *
 *   Noise_IK_25519_ChaChaPoly_SHA256       sessions:  <- s  ...  -> e, es, s, ss   <- e, ee, se
 *   Noise_IKpsk1_25519_ChaChaPoly_SHA256   pairing:   <- s  ...  -> e, es, s, ss, psk   <- e, ee, se
 *
 * The primitives are injected (`NoiseCrypto`): Node's crypto on the desktop, audited pure-JS @noble on the phone. This file
 * has no platform dependency so both sides run exactly this state machine.
 */
import {concat} from './bytes.ts';

export interface KeyPair { publicKey: Uint8Array; privateKey: Uint8Array }
export interface NoiseCrypto {
  generateKeyPair(): KeyPair;
  /** X25519. */
  dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** ChaCha20-Poly1305 (IETF, 12-byte nonce); ciphertext carries the 16-byte tag at the end. */
  encrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Throws when the tag does not verify. */
  decrypt(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;
  randomBytes(length: number): Uint8Array;
}
export type NoisePattern = 'IK' | 'IKpsk1';
export const NOISE_MAX_MESSAGE = 65535;
const DHLEN = 32, TAGLEN = 16;
const EMPTY = new Uint8Array(0);

/** Noise nonce: 32 zero bits, then the 64-bit counter little-endian. */
function nonceBytes(n: number): Uint8Array {
  const out = new Uint8Array(12);
  let value = n;
  for (let i = 4; i < 12; i++) { out[i] = value % 256; value = Math.floor(value / 256); }
  return out;
}

export class CipherState {
  private n = 0;
  constructor(private readonly crypto: NoiseCrypto, private key: Uint8Array | null = null) {}
  hasKey(): boolean { return this.key !== null; }
  setKey(key: Uint8Array): void { this.key = key; this.n = 0; }
  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    if (this.n >= Number.MAX_SAFE_INTEGER) throw new Error('Noise nonce exhausted.');
    const out = this.crypto.encrypt(this.key, nonceBytes(this.n), ad, plaintext);
    this.n++;
    return out;
  }
  /** A failed decryption does not advance the counter; the caller closes the session. */
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    const out = this.crypto.decrypt(this.key, nonceBytes(this.n), ad, ciphertext);
    this.n++;
    return out;
  }
}

class SymmetricState {
  ck: Uint8Array; h: Uint8Array; readonly cipher: CipherState;
  constructor(private readonly crypto: NoiseCrypto, protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= 32) { this.h = new Uint8Array(32); this.h.set(name); } else this.h = crypto.sha256(name);
    this.ck = this.h;
    this.cipher = new CipherState(crypto);
  }
  private hkdf(ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
    const temp = this.crypto.hmacSha256(this.ck, ikm);
    const out1 = this.crypto.hmacSha256(temp, Uint8Array.of(1));
    const out2 = this.crypto.hmacSha256(temp, concat(out1, Uint8Array.of(2)));
    return outputs === 2 ? [out1, out2] : [out1, out2, this.crypto.hmacSha256(temp, concat(out2, Uint8Array.of(3)))];
  }
  mixKey(ikm: Uint8Array): void { const [ck, key] = this.hkdf(ikm, 2); this.ck = ck!; this.cipher.setKey(key!); }
  mixHash(data: Uint8Array): void { this.h = this.crypto.sha256(concat(this.h, data)); }
  mixKeyAndHash(ikm: Uint8Array): void { const [ck, h, key] = this.hkdf(ikm, 3); this.ck = ck!; this.mixHash(h!); this.cipher.setKey(key!); }
  encryptAndHash(plaintext: Uint8Array): Uint8Array { const out = this.cipher.encrypt(this.h, plaintext); this.mixHash(out); return out; }
  decryptAndHash(ciphertext: Uint8Array): Uint8Array { const out = this.cipher.decrypt(this.h, ciphertext); this.mixHash(ciphertext); return out; }
  split(): [CipherState, CipherState] {
    const [k1, k2] = this.hkdf(EMPTY, 2);
    return [new CipherState(this.crypto, k1!), new CipherState(this.crypto, k2!)];
  }
}

type Token = 'e' | 's' | 'es' | 'se' | 'ss' | 'ee' | 'psk';
const MESSAGES: Record<NoisePattern, Token[][]> = {
  IK: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']],
  IKpsk1: [['e', 'es', 's', 'ss', 'psk'], ['e', 'ee', 'se']],
};

export interface HandshakeOptions {
  pattern: NoisePattern;
  initiator: boolean;
  /** Our static key pair. */
  s: KeyPair;
  /** The responder's static public key: the initiator knows it in advance (from the QR); the responder passes its own s. */
  rs?: Uint8Array;
  /** IKpsk1 only: the 32-byte one-time pairing code. */
  psk?: Uint8Array;
  prologue: Uint8Array;
}

/** One handshake. Call writeMessage/readMessage in turn, then split(). Any failure throws; the caller drops the connection. */
export class Handshake {
  private readonly ss: SymmetricState;
  private e: KeyPair | null = null;
  private re: Uint8Array | null = null;
  private rsKey: Uint8Array | null;
  private step = 0;
  private readonly psk: boolean;
  constructor(private readonly crypto: NoiseCrypto, private readonly o: HandshakeOptions) {
    this.psk = o.pattern === 'IKpsk1';
    if (this.psk && o.psk?.length !== 32) throw new Error('A 32-byte pre-shared key is required.');
    this.ss = new SymmetricState(crypto, `Noise_${o.pattern}_25519_ChaChaPoly_SHA256`);
    this.ss.mixHash(o.prologue);
    // Pre-message `<- s`: the responder's static key.
    const responderStatic = o.initiator ? o.rs : o.s.publicKey;
    if (!responderStatic || responderStatic.length !== DHLEN) throw new Error('The responder static key is required.');
    this.ss.mixHash(responderStatic);
    this.rsKey = o.initiator ? o.rs! : null;
  }
  /** The other side's static public key (the phone's, on the desktop, once message 1 is read). */
  get remoteStatic(): Uint8Array | null { return this.rsKey; }
  get finished(): boolean { return this.step >= 2; }
  get handshakeHash(): Uint8Array { return this.ss.h; }

  private dhToken(token: 'es' | 'se' | 'ss' | 'ee'): void {
    const {initiator, s} = this.o;
    const need = <T>(value: T | null | undefined): T => { if (!value) throw new Error('Noise handshake out of order.'); return value; };
    let shared: Uint8Array;
    if (token === 'ee') shared = this.crypto.dh(need(this.e).privateKey, need(this.re));
    else if (token === 'ss') shared = this.crypto.dh(s.privateKey, need(this.rsKey));
    else if ((token === 'es') === initiator) shared = this.crypto.dh(need(this.e).privateKey, need(this.rsKey)); // es (initiator) / se (responder)
    else shared = this.crypto.dh(s.privateKey, need(this.re)); // se (initiator) / es (responder)
    this.ss.mixKey(shared);
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    if (this.finished || (this.step === 0) !== this.o.initiator) throw new Error('Noise handshake out of order.');
    const parts: Uint8Array[] = [];
    for (const token of MESSAGES[this.o.pattern][this.step]!) {
      if (token === 'e') {
        this.e = this.crypto.generateKeyPair();
        parts.push(this.e.publicKey); this.ss.mixHash(this.e.publicKey);
        if (this.psk) this.ss.mixKey(this.e.publicKey);
      } else if (token === 's') parts.push(this.ss.encryptAndHash(this.o.s.publicKey));
      else if (token === 'psk') this.ss.mixKeyAndHash(this.o.psk!);
      else this.dhToken(token);
    }
    parts.push(this.ss.encryptAndHash(payload));
    this.step++;
    const message = concat(...parts);
    if (message.length > NOISE_MAX_MESSAGE) throw new Error('Noise message too large.');
    return message;
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.finished || (this.step === 0) === this.o.initiator) throw new Error('Noise handshake out of order.');
    let at = 0;
    const take = (length: number) => { if (at + length > message.length) throw new Error('Noise message too short.'); const out = message.subarray(at, at + length); at += length; return out; };
    for (const token of MESSAGES[this.o.pattern][this.step]!) {
      if (token === 'e') {
        this.re = Uint8Array.from(take(DHLEN)); this.ss.mixHash(this.re);
        if (this.psk) this.ss.mixKey(this.re);
      } else if (token === 's') this.rsKey = Uint8Array.from(this.ss.decryptAndHash(take(this.ss.cipher.hasKey() ? DHLEN + TAGLEN : DHLEN)));
      else if (token === 'psk') this.ss.mixKeyAndHash(this.o.psk!);
      else this.dhToken(token);
    }
    const payload = this.ss.decryptAndHash(message.subarray(at));
    this.step++;
    return payload;
  }

  /** After both messages: [send, receive] for this side. */
  split(): {send: CipherState; receive: CipherState} {
    if (!this.finished) throw new Error('The Noise handshake is not finished.');
    const [c1, c2] = this.ss.split();
    return this.o.initiator ? {send: c1, receive: c2} : {send: c2, receive: c1};
  }
}
