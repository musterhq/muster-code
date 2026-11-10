/** The pairing record in secure storage (#326): Keychain on iOS, Keystore-backed storage on Android, via expo-secure-store,
 *  readable only while the phone is unlocked and never in backups. */
import type {PairedRecord} from '../shared';

export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}
export interface PairingStore {
  load(): Promise<PairedRecord | null>;
  save(record: PairedRecord): Promise<void>;
  clear(): Promise<void>;
}
const KEY = 'muster.pairing.v1';
const FIELDS: Array<keyof PairedRecord> = ['relayUrl', 'route', 'desktopKey', 'desktopName', 'deviceId', 'publicKey', 'privateKey'];

export function createPairingStore(secure: SecureStoreLike): PairingStore {
  return {
    async load() {
      const raw = await secure.getItemAsync(KEY);
      if (!raw) return null;
      try {
        const record = JSON.parse(raw) as PairedRecord;
        return FIELDS.every(field => typeof record[field] === 'string') ? record : null;
      } catch { return null; }
    },
    save: record => secure.setItemAsync(KEY, JSON.stringify(record)),
    clear: () => secure.deleteItemAsync(KEY),
  };
}
/** For tests and previews. */
export function memorySecureStore(): SecureStoreLike {
  const values = new Map<string, string>();
  return {
    async getItemAsync(key) { return values.get(key) ?? null; },
    async setItemAsync(key, value) { values.set(key, value); },
    async deleteItemAsync(key) { values.delete(key); },
  };
}
