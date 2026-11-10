/** The phone link code shared with the desktop app (packages/agent-app/src/shared/mobile). One import point for the app. */
export * from '../../agent-app/src/shared/mobile/protocol.ts';
export * from '../../agent-app/src/shared/mobile/client.ts';
export {Handshake, CipherState, type KeyPair, type NoiseCrypto} from '../../agent-app/src/shared/mobile/noise.ts';
export {SecureChannel, prologue} from '../../agent-app/src/shared/mobile/channel.ts';
