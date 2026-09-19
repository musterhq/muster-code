/** Scoped folder browsing: bounded listings and bounded text reads. */
import { promises as fs, type Dir } from 'node:fs';
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

/** Bounded on-demand search; never indexes the workspace in the background. */
export async function searchFiles(root: string, rel: string, query: string): Promise<{entries: FileEntry[]; truncated: boolean}> {
  if (!query.trim() || query.length > 256) throw new Error('Enter a file name of 1–256 characters.');
  await resolveInside(root, rel);
  const pending = [rel], entries: FileEntry[] = [];
  const needle = query.trim().toLowerCase();
  let inspected = 0, directories = 0, partial = false;
  while (pending.length && directories < 200 && inspected < 10_000) {
    const path = pending.shift()!;
    let directory: Dir;
    try {directory = await fs.opendir(await resolveInside(root,path));}
    catch (error) {if (!directories) throw error; partial = true; continue;}
    directories++;
    for await (const entry of directory) {
      if (++inspected > 10_000) return {entries,truncated:true};
      if (entry.name === '.git') continue;
      // Do not walk symlinks: no cycles or unexpected traversal during search.
      if (entry.isSymbolicLink()) {partial = true; continue;}
      const child = join(path,entry.name);
      if (entry.isDirectory()) {if(pending.length < 200) pending.push(child); else partial = true;}
      else if (entry.isFile() && child.toLowerCase().includes(needle)) {
        entries.push({name:entry.name,path:child,kind:'file'});
        if (entries.length === 100) return {entries,truncated:true};
      }
    }
  }
  return {entries,truncated:partial || pending.length > 0};
}
