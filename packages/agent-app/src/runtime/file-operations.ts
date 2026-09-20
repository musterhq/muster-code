/**
 * Scoped file operations: create, rename, move and trash inside a registered
 * folder root. Every path is re-validated through `resolveInside` (lexical +
 * symlink containment) before touching disk. No overwrite, no permanent
 * recursive delete — deletion goes through the native OS Trash only.
 */
import { promises as fs, type Stats } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { shell } from 'electron';
import type { FileEntry } from '../shared/protocol.ts';
import { resolveInside } from './paths.ts';

function relFrom(root: string, abs: string): string {
  return abs.slice(root.length + 1);
}

/** A leaf name (not a path): rejects separators, traversal and control chars. */
function validateName(name: string): void {
  if (!name || name.length > 255) throw new Error('Enter a name of 1–255 characters.');
  if (name === '.' || name === '..') throw new Error('Invalid name.');
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Name cannot contain path separators.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) throw new Error('Name contains control characters.');
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function createEntry(
  root: string,
  dirRel: string,
  name: string,
  kind: 'file' | 'directory',
): Promise<FileEntry> {
  validateName(name);
  const dirAbs = await resolveInside(root, dirRel);
  const dirStat = await statOrNull(dirAbs);
  if (!dirStat?.isDirectory()) throw new Error('Destination folder does not exist.');
  const abs = join(dirAbs, name);
  if (await statOrNull(abs)) throw new Error(`"${name}" already exists.`);
  if (kind === 'directory') {
    await fs.mkdir(abs);
  } else {
    const handle = await fs.open(abs, 'wx');
    await handle.close();
  }
  return { name, path: relFrom(root, abs), kind };
}

export async function renameEntry(root: string, rel: string, name: string): Promise<FileEntry> {
  validateName(name);
  const srcAbs = await resolveInside(root, rel);
  const stat = await statOrNull(srcAbs);
  if (!stat) throw new Error(`Not found: ${rel}`);
  const destAbs = join(dirname(srcAbs), name);
  if (destAbs === srcAbs) throw new Error('Choose a different name.');
  if (await statOrNull(destAbs)) throw new Error(`"${name}" already exists.`);
  await fs.rename(srcAbs, destAbs);
  return { name, path: relFrom(root, destAbs), kind: stat.isDirectory() ? 'directory' : 'file' };
}

export async function moveEntry(root: string, rel: string, toDirRel: string): Promise<FileEntry> {
  const srcAbs = await resolveInside(root, rel);
  const stat = await statOrNull(srcAbs);
  if (!stat) throw new Error(`Not found: ${rel}`);
  const destDirAbs = await resolveInside(root, toDirRel);
  const destDirStat = await statOrNull(destDirAbs);
  if (!destDirStat?.isDirectory()) throw new Error('Destination folder does not exist.');
  if (destDirAbs === srcAbs || destDirAbs.startsWith(srcAbs + sep)) {
    throw new Error('Cannot move a folder into itself.');
  }
  const name = basename(srcAbs);
  const destAbs = join(destDirAbs, name);
  if (destAbs === srcAbs) throw new Error('Already in that folder.');
  if (await statOrNull(destAbs)) throw new Error(`"${name}" already exists there.`);
  await fs.rename(srcAbs, destAbs);
  return { name, path: relFrom(root, destAbs), kind: stat.isDirectory() ? 'directory' : 'file' };
}

/** Native OS Trash only — never a permanent recursive delete. */
export async function trashEntry(root: string, rel: string): Promise<void> {
  const abs = await resolveInside(root, rel);
  if (!(await statOrNull(abs))) throw new Error(`Not found: ${rel}`);
  try {
    await shell.trashItem(abs);
  } catch (error) {
    throw new Error(`Could not move to Trash: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reveals the entry in the OS file manager. Read-only, always available. */
export async function revealEntry(root: string, rel: string): Promise<void> {
  const abs = await resolveInside(root, rel);
  if (!(await statOrNull(abs))) throw new Error(`Not found: ${rel}`);
  shell.showItemInFolder(abs);
}
