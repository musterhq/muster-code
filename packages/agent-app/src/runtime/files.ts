/** Scoped folder browsing: bounded listings and bounded text reads. */
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { FileEntry } from '../shared/protocol.ts';
import { resolveInside } from './paths.ts';

const MAX_ENTRIES = 2_000;
const MAX_TEXT_BYTES = 512 * 1024;

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8_192);
  return probe.includes(0);
}

export async function listFiles(root: string, rel: string): Promise<FileEntry[]> {
  const abs = await resolveInside(root, rel);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name === '.git') continue;
    if (!dirent.isFile() && !dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    let kind: FileEntry['kind'] = dirent.isDirectory() ? 'directory' : 'file';
    if (dirent.isSymbolicLink()) {
      // Only symlinks that stay inside the root are shown, typed by their target.
      try {
        const real = await resolveInside(root, join(rel, dirent.name));
        kind = (await fs.stat(real)).isDirectory() ? 'directory' : 'file';
      } catch {
        continue;
      }
    }
    entries.push({ name: dirent.name, path: relative(root, join(abs, dirent.name)), kind });
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
  return entries;
}

export async function readFile(root: string, rel: string): Promise<{ path: string; text: string; truncated: boolean }> {
  const abs = await resolveInside(root, rel);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
  const handle = await fs.open(abs, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const shown = buffer.subarray(0, Math.min(bytesRead, MAX_TEXT_BYTES));
    if (looksBinary(shown)) throw new Error(`Binary file (no text preview): ${rel}`);
    return { path: rel, text: shown.toString('utf8'), truncated: bytesRead > MAX_TEXT_BYTES };
  } finally {
    await handle.close();
  }
}
