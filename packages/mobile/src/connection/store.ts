/** Pairing records in secure storage (#326): Keychain on iOS, Keystore-backed storage on Android, via expo-secure-store,
 *  readable only while the phone is unlocked and never in backups. */
import {cleanLanAddresses, type PairedRecord} from '../shared';

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
/** Every paired computer (#326 phase 4). Each record, with its own key pair, sits under its own secure-storage key, so
 *  pairing, unpairing or a corrupt entry for one computer never touches another's keys. `load` is the first computer. */
export interface ComputerStore extends PairingStore {
  list(): Promise<PairedRecord[]>;
  remove(id: string): Promise<void>;
}
/** A computer is known by its route: pairing the same computer again replaces its record. */
export const computerId = (record: PairedRecord): string => record.route;
/** The phase 1 to 3 single record, moved into the list on first load. */
const LEGACY_KEY = 'muster.pairing.v1';
const INDEX_KEY = 'muster.computers.v1';
const recordKey = (id: string) => `muster.computer.v1.${id}`;
const SAFE_ID = /^[a-f0-9]{16,64}$/;
const FIELDS: Array<Exclude<keyof PairedRecord, 'lan'>> = ['relayUrl', 'route', 'desktopKey', 'desktopName', 'deviceId', 'publicKey', 'privateKey'];

function parse(raw: string | null): PairedRecord | null {
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as PairedRecord;
    if (!FIELDS.every(field => typeof record[field] === 'string') || !SAFE_ID.test(record.route)) return null;
    // Direct addresses are optional and re-checked: a record never makes the phone dial anything but a private address.
    const lan = cleanLanAddresses(record.lan);
    const {lan: _stored, ...rest} = record;
    return lan ? {...rest, lan} : rest;
  } catch { return null; }
}

export function createComputerStore(secure: SecureStoreLike): ComputerStore {
  let queue: Promise<unknown> = Promise.resolve();
  /** Index changes run one at a time, so two pairings finishing together both stay listed. */
  const serial = <T,>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => undefined); return next; };
  const ids = async (): Promise<string[]> => {
    try { const list = JSON.parse((await secure.getItemAsync(INDEX_KEY)) ?? '[]') as unknown; return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && SAFE_ID.test(id)) : []; } catch { return []; }
  };
  const migrate = async (): Promise<string[]> => {
    const legacy = parse(await secure.getItemAsync(LEGACY_KEY));
    const known = await ids();
    if (!legacy) return known;
    await secure.setItemAsync(recordKey(legacy.route), JSON.stringify(legacy));
    const next = known.includes(legacy.route) ? known : [legacy.route, ...known];
    await secure.setItemAsync(INDEX_KEY, JSON.stringify(next));
    await secure.deleteItemAsync(LEGACY_KEY);
    return next;
  };
  const list = () => serial(async () => {
    const out: PairedRecord[] = [];
    for (const id of await migrate()) { const record = parse(await secure.getItemAsync(recordKey(id))); if (record && record.route === id) out.push(record); }
    return out;
  });
  const remove = (id: string) => serial(async () => {
    await secure.deleteItemAsync(recordKey(id));
    await secure.setItemAsync(INDEX_KEY, JSON.stringify((await migrate()).filter(entry => entry !== id)));
  });
  return {
    list, remove,
    async load() { return (await list())[0] ?? null; },
    save: record => serial(async () => {
      if (!SAFE_ID.test(record.route)) throw new Error('That pairing record is not valid.');
      await secure.setItemAsync(recordKey(record.route), JSON.stringify(record));
      const known = await migrate();
      if (!known.includes(record.route)) await secure.setItemAsync(INDEX_KEY, JSON.stringify([...known, record.route]));
    }),
    async clear() { for (const record of await list()) await remove(record.route); },
  };
}
/** The phase 1 name: the same store. */
export const createPairingStore = createComputerStore;
/** For tests and previews. */
export function memorySecureStore(): SecureStoreLike {
  const values = new Map<string, string>();
  return {
    async getItemAsync(key) { return values.get(key) ?? null; },
    async setItemAsync(key, value) { values.set(key, value); },
    async deleteItemAsync(key) { values.delete(key); },
  };
}
