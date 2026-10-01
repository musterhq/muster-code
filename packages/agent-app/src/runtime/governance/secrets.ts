/**
 * Project secret vault (G23). Values live only in the encrypted secret store (Keychain-backed, see secret-store.ts):
 * one entry per version, so a rotation keeps the previous versions for rollback. Metadata and the audit log live in the
 * governance database and never contain a value. Nothing here logs a value or returns one to the renderer.
 */
import { createHash } from 'node:crypto';
import type { ProjectSecret } from '../../shared/domains/project-governance-protocol.ts';
import { isReservedName, RESERVED_HELP, SECRET_NAME } from './blocks.ts';
import type { GovernanceStore } from './store.ts';

export interface VaultStore { secureStorage(): boolean; set(id: string, value: unknown): unknown; get(id: string): string | undefined; clear(id: string): unknown }
const KEEP_VERSIONS = 5;
export const VALUE_HELP = 'A secret value is one line with no spaces, up to 4,096 characters.';
export function validValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error(VALUE_HELP);
  const v = value.trim();
  if (!v || v.length > 4096 || /[\s\x00-\x1f\x7f]/.test(v)) throw new Error(VALUE_HELP);
  return v;
}
export function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim().toUpperCase() : '';
  if (!SECRET_NAME.test(n)) throw new Error('A secret name is 2–64 capital letters, digits or underscores, starting with a letter (like NPM_TOKEN).');
  if (isReservedName(n)) throw new Error(RESERVED_HELP);
  return n;
}
export const MAX_SECRETS = 100;

export class ProjectVault {
  constructor(private store: GovernanceStore, private secrets: () => VaultStore) {}
  private id(projectId: string, name: string, version: number) { return `ps_${createHash('sha256').update(projectId).digest('hex').slice(0, 12)}_${name}_v${version}`; }
  secure(): boolean { return this.secrets().secureStorage(); }
  save(projectId: string, rawName: unknown, rawValue: unknown, o: { description?: string; expiresAt?: string | null; actor: string }): ProjectSecret {
    const name = validName(rawName), value = validValue(rawValue);
    if (!this.secure()) throw new Error('This computer has no secure keychain available, so the secret was not saved. Muster never stores secrets in plain text.');
    if (o.expiresAt != null && !Number.isFinite(Date.parse(o.expiresAt))) throw new Error('Enter a valid expiry date, or leave it empty.');
    const cur = this.store.secretMeta(projectId, name);
    if (!cur && this.store.secretsMeta(projectId).length >= MAX_SECRETS) throw new Error(`A project holds up to ${MAX_SECRETS} secrets.`);
    const version = Math.max(0, ...(cur?.versions ?? []).map(v => v.version)) + 1, at = new Date().toISOString();
    this.secrets().set(this.id(projectId, name, version), value);
    const versions = [...(cur?.versions ?? []), { version, createdAt: at, by: o.actor }];
    for (const old of versions.splice(0, Math.max(0, versions.length - KEEP_VERSIONS))) this.secrets().clear(this.id(projectId, name, old.version));
    this.store.putSecretMeta({ projectId, name, description: o.description ?? cur?.description ?? '', version, versions, createdAt: cur?.createdAt, rotatedAt: cur ? at : null, expiresAt: o.expiresAt === undefined ? cur?.expiresAt ?? null : o.expiresAt });
    this.store.addSecretEvent(projectId, name, cur ? 'rotate' : 'create', o.actor, `version ${version}`);
    return this.view(projectId, name, []);
  }
  rollback(projectId: string, rawName: unknown, version: number, actor: string): ProjectSecret {
    const name = validName(rawName), cur = this.store.secretMeta(projectId, name);
    if (!cur) throw new Error('That secret does not exist.');
    if (!cur.versions.some(v => v.version === version)) throw new Error('That version is no longer kept.');
    if (cur.version === version) return this.view(projectId, name, []);
    this.store.putSecretMeta({ ...cur, version, versions: cur.versions, rotatedAt: new Date().toISOString() });
    this.store.addSecretEvent(projectId, name, 'rollback', actor, `back to version ${version}`);
    return this.view(projectId, name, []);
  }
  remove(projectId: string, rawName: unknown, actor: string) {
    const name = validName(rawName), cur = this.store.secretMeta(projectId, name);
    if (!cur) throw new Error('That secret does not exist.');
    for (const v of cur.versions) this.secrets().clear(this.id(projectId, name, v.version));
    this.store.deleteSecretMeta(projectId, name);
    this.store.addSecretEvent(projectId, name, 'remove', actor, 'all versions deleted');
  }
  /** The current value, or undefined when missing, expired or unreadable. Never logged. */
  value(projectId: string, name: string): { value: string; version: number } | undefined {
    const meta = this.store.secretMeta(projectId, name);
    if (!meta || (meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now())) return undefined;
    const value = this.secrets().get(this.id(projectId, name, meta.version));
    return value ? { value, version: meta.version } : undefined;
  }
  expired(projectId: string, name: string): boolean { const m = this.store.secretMeta(projectId, name); return Boolean(m?.expiresAt && Date.parse(m.expiresAt) <= Date.now()); }
  view(projectId: string, name: string, grantedTo: string[]): ProjectSecret {
    const m = this.store.secretMeta(projectId, name)!;
    return { name: m.name, description: m.description, version: m.version, versions: m.versions.map(v => ({ ...v, current: v.version === m.version })).reverse(), createdAt: m.createdAt, rotatedAt: m.rotatedAt, expiresAt: m.expiresAt, grantedTo };
  }
  list(projectId: string, grants: ReadonlyMap<string, string[]>): ProjectSecret[] { return this.store.secretsMeta(projectId).map(m => this.view(projectId, m.name, grants.get(m.name) ?? [])); }
}
