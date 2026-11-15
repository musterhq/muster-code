/** Noise primitives on the phone (#326): audited pure-JS @noble (no native module). Random bytes are injected: expo-crypto
 *  on the device, Node's crypto in tests. */
import {x25519} from '@noble/curves/ed25519.js';
import {chacha20poly1305} from '@noble/ciphers/chacha.js';
import {sha256} from '@noble/hashes/sha2.js';
import {hmac} from '@noble/hashes/hmac.js';
import type {NoiseCrypto} from '../shared';

export function nobleNoiseCrypto(random: (length: number) => Uint8Array): NoiseCrypto {
  return {
    generateKeyPair() {
      const privateKey = random(32);
      return {privateKey, publicKey: x25519.getPublicKey(privateKey)};
    },
    dh(privateKey, publicKey) {
      const shared = x25519.getSharedSecret(privateKey, publicKey);
      if (shared.every(byte => byte === 0)) throw new Error('Invalid public key.');
      return shared;
    },
    encrypt: (key, nonce, ad, plaintext) => chacha20poly1305(key, nonce, ad).encrypt(plaintext),
    decrypt: (key, nonce, ad, ciphertext) => chacha20poly1305(key, nonce, ad).decrypt(ciphertext),
    sha256: data => sha256(data),
    hmacSha256: (key, data) => hmac(sha256, key, data),
    randomBytes: random,
  };
}
