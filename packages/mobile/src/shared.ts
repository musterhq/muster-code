/** The phone link code shared with the desktop app (packages/agent-app/src/shared/mobile). One import point for the app. */
export * from '../../agent-app/src/shared/mobile/protocol.ts';
export * from '../../agent-app/src/shared/mobile/client.ts';
export {Handshake, CipherState, type KeyPair, type NoiseCrypto} from '../../agent-app/src/shared/mobile/noise.ts';
export {SecureChannel, prologue, groupCheckCode} from '../../agent-app/src/shared/mobile/channel.ts';
import {toBase64} from '../../agent-app/src/shared/mobile/bytes.ts';
/** URL-safe base64 without padding, as pairing records store keys. */
export const toBase64Url = (bytes: Uint8Array): string => toBase64(bytes, true);
