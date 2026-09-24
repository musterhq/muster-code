/**
 * W5-E.b2 / WRK-17: read-only access to files an agent wrote or named OUTSIDE the conversation's folders.
 * `authorize` hands out an opaque handle only when the exact path appears in that chat's tool or approval items
 * (the agent wrote, read or listed it) and it is a regular file that is not itself a symlink. `read` re-checks the
 * file on every call (same realpath, same inode, still regular) and never writes. Handles live in memory only.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, normalize, sep } from 'node:path';
import type { TimelineItem } from '../shared/protocol.ts';
import type { ArtifactFile, ArtifactHandle } from '../shared/domains/artifacts-protocol.ts';

export const MAX_ARTIFACT_READ_BYTES = 2 * 1024 * 1024;
const MAX_HANDLES = 256;
const HANDLE_TTL_MS = 60 * 60_000;
/** Credential stores are never opened this way, even when an agent named them. */
const DENIED = /(^|\/)(\.ssh|\.gnupg|\.aws|\.kube|\.docker|Keychains|\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials)(\/|$)|(^|\/)(id_(rsa|ed25519|ecdsa|dsa))(\.pub)?$|(^|\/)\.env(\.[^/]*)?$/;

interface Grant { chatId: string; path: string; real: string; ino: number; dev: number; expires: number }

const expand = (value: string, home: string) => value === '~' ? home : value.startsWith('~/') ? home + value.slice(1) : value;

/** True when `path` is named by one of the chat's tool/approval items (text or structured data). */
export function timelineMentions(items: readonly TimelineItem[], path: string): boolean {
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'approval') continue;
    if (item.text.includes(path)) return true;
    let data = '';
    try { data = item.data ? JSON.stringify(item.data) : ''; } catch { data = ''; }
    // JSON escapes `/` never, but it does escape quotes and backslashes; compare against the JSON-encoded form too.
    if (data && (data.includes(path) || data.includes(JSON.stringify(path).slice(1, -1)))) return true;
  }
  return false;
}

export class ArtifactAccess {
  private grants = new Map<string, Grant>();
  constructor(private readonly options: { timeline(chatId: string): TimelineItem[]; chatExists(chatId: string): boolean; home?: string; now?: () => number }) {}
  private now() { return this.options.now?.() ?? Date.now(); }

  async authorize(chatId: string, rawPath: unknown): Promise<ArtifactHandle> {
    if (!this.options.chatExists(chatId)) throw new Error('This chat no longer exists.');
    if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(rawPath)) throw new Error('Choose a file.');
    const home = this.options.home ?? homedir();
    const expanded = expand(rawPath, home);
    if (!isAbsolute(expanded) || expanded.split('/').includes('..')) throw new Error('Only absolute paths can be opened this way.');
    const path = normalize(expanded).replace(/\/+$/, '');
    if (DENIED.test(path)) throw new Error('Credential files are never opened from a chat.');
    const items = this.options.timeline(chatId);
    const tilde = path.startsWith(home + sep) ? `~${path.slice(home.length)}` : undefined;
    if (!timelineMentions(items, path) && !(tilde && timelineMentions(items, tilde))) throw new Error('Only files this chat’s agent wrote or used can be opened from here.');
    const link = await fs.lstat(path).catch(() => { throw new Error('This file no longer exists.'); });
    if (link.isSymbolicLink()) throw new Error('This path is a symbolic link; open its target instead.');
    if (!link.isFile()) throw new Error('Only regular files can be opened.');
    const real = await fs.realpath(path);
    if (DENIED.test(real)) throw new Error('Credential files are never opened from a chat.');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev) throw new Error('This file changed while it was being checked.');
    this.prune();
    const handle = randomBytes(18).toString('base64url');
    this.grants.set(handle, { chatId, path, real, ino: stat.ino, dev: stat.dev, expires: this.now() + HANDLE_TTL_MS });
    return { handle, path, name: path.split('/').pop() || path, size: stat.size };
  }

  async read(handle: unknown): Promise<ArtifactFile> {
    const grant = typeof handle === 'string' ? this.grants.get(handle) : undefined;
    if (!grant || grant.expires < this.now()) { if (typeof handle === 'string') this.grants.delete(handle); throw new Error('This file link expired. Open it from the chat again.'); }
    if (!this.options.chatExists(grant.chatId)) { this.grants.delete(handle as string); throw new Error('This chat no longer exists.'); }
    const link = await fs.lstat(grant.path).catch(() => { throw new Error('This file no longer exists.'); });
    const real = link.isSymbolicLink() ? '' : await fs.realpath(grant.path).catch(() => '');
    if (real !== grant.real || !link.isFile() || link.ino !== grant.ino || link.dev !== grant.dev) throw new Error('This file was replaced since it was opened. Open it from the chat again.');
    const file = await fs.open(real, 'r');
    try {
      const stat = await file.stat();
      const length = Math.min(stat.size, MAX_ARTIFACT_READ_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const binary = bytes.subarray(0, 8192).includes(0);
      return { handle: handle as string, path: grant.path, name: grant.path.split('/').pop() || grant.path, size: stat.size, truncated: stat.size > bytesRead, binary, text: binary ? '' : bytes.toString('utf8') };
    } finally { await file.close(); }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, grant] of this.grants) if (grant.expires < now) this.grants.delete(key);
    while (this.grants.size >= MAX_HANDLES) this.grants.delete(this.grants.keys().next().value!);
  }
}
