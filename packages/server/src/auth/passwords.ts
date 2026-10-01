/** scrypt password hashing (node:crypto, no native deps). Format: scrypt$N$r$p$saltB64$hashB64. */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (password: string, salt: Buffer, len: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password.normalize('NFKC'), salt, len, options, (error, key) => error ? reject(error) : resolve(key)));
export const PASSWORD_PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 64 } as const;
export const MIN_PASSWORD = 10;

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string') throw new Error('Enter a password.');
  if (password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`);
  if (password.length > 1024) throw new Error('That password is too long.');
  return password;
}

export async function hashPassword(password: string, params: { N: number; r: number; p: number; keylen: number } = PASSWORD_PARAMS): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time verify. Unknown formats and malformed hashes never verify. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored || typeof password !== 'string') return false;
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const n = Number(N), rr = Number(r), pp = Number(p);
  if (![n, rr, pp].every(Number.isInteger) || n > 1 << 20) return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: n, r: rr, p: pp, maxmem: 256 * n * rr });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A dummy hash verified for unknown usernames, so response time does not reveal which accounts exist. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => dummy ??= hashPassword('muster-server-dummy-password');
