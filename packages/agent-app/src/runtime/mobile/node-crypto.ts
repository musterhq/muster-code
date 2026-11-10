/** Noise primitives from Node's built-in crypto (#326): X25519, ChaCha20-Poly1305, SHA-256. No new dependency. */
import {createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign} from 'node:crypto';
import type {KeyPair, NoiseCrypto} from '../../shared/mobile/noise.ts';

// DER wrappers for raw 32-byte X25519 keys (RFC 8410).
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const privateKey = (raw: Uint8Array) => createPrivateKey({key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8'});
const publicKey = (raw: Uint8Array) => {
  if (raw.length !== 32) throw new Error('Invalid public key.');
  return createPublicKey({key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki'});
};
const bytes = (value: Buffer): Uint8Array => new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

export function nodeNoiseCrypto(): NoiseCrypto {
  return {
    generateKeyPair(): KeyPair {
      const pair = generateKeyPairSync('x25519');
      return {privateKey: bytes(pair.privateKey.export({format: 'der', type: 'pkcs8'}).subarray(PKCS8.length)), publicKey: bytes(pair.publicKey.export({format: 'der', type: 'spki'}).subarray(SPKI.length))};
    },
    dh(secret, other) {
      const shared = bytes(diffieHellman({privateKey: privateKey(secret), publicKey: publicKey(other)}));
      // A low-order public key gives an all-zero secret: refuse it.
      if (shared.every(byte => byte === 0)) throw new Error('Invalid public key.');
      return shared;
    },
    encrypt(key, nonce, ad, plaintext) {
      const cipher = createCipheriv('chacha20-poly1305', key, nonce, {authTagLength: 16});
      cipher.setAAD(ad, {plaintextLength: plaintext.length});
      return bytes(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
    },
    decrypt(key, nonce, ad, ciphertext) {
      if (ciphertext.length < 16) throw new Error('Ciphertext too short.');
      const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {authTagLength: 16});
      decipher.setAAD(ad, {plaintextLength: ciphertext.length - 16});
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      return bytes(Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]));
    },
    sha256: data => bytes(createHash('sha256').update(data).digest()),
    hmacSha256: (key, data) => bytes(createHmac('sha256', key).update(data).digest()),
    randomBytes: length => bytes(randomBytes(length)),
  };
}

// Ed25519 for the relay route key (#326 security review): the relay sends a nonce and the desktop signs it.
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
export interface RouteKey { publicKey: Uint8Array; privateKey: Uint8Array }
export function generateRouteKey(): RouteKey {
  const pair = generateKeyPairSync('ed25519');
  return {privateKey: bytes(pair.privateKey.export({format: 'der', type: 'pkcs8'}).subarray(ED_PKCS8.length)), publicKey: bytes(pair.publicKey.export({format: 'der', type: 'spki'}).subarray(12))};
}
export function signWithRouteKey(key: RouteKey, data: Uint8Array): Uint8Array {
  return bytes(sign(null, data, createPrivateKey({key: Buffer.concat([ED_PKCS8, key.privateKey]), format: 'der', type: 'pkcs8'})));
}
