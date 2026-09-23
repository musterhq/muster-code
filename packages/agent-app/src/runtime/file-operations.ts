import { promises as fs } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

// Mutations reject symlink components rather than modifying their targets.
// This is a workspace boundary, not a security sandbox for hostile host processes.
export async function mutablePath(root: string, relative: string, existing = false): Promise<string> {
  if (typeof relative !== 'string' || relative.length > 4096 || isAbsolute(relative) || relative.includes('\0')) throw new Error('Use a path relative to this folder.');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes('\\'))) throw new Error('This path cannot be changed from the file pane.');
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Change symlinked items in their original folder.');
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('The parent path is not a folder.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existing || i !== parts.length - 1) throw error;
    }
  }
  if (!current.startsWith(realRoot + sep)) throw new Error('Cannot change the workspace root.');
  return current;
}

const pending = new Map<string, number>();
const tails = new Map<string, Promise<unknown>>();
export async function fileOperation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = await fs.realpath(root);
  const count = pending.get(key) ?? 0;
  if (count >= 8) throw new Error('File operations are busy. Wait for the current operation.');
  pending.set(key, count + 1);
  const result = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  tails.set(key, result);
  try { return await result; }
  finally {
    const left = (pending.get(key) ?? 1) - 1;
    if (left) pending.set(key, left); else pending.delete(key);
    if (tails.get(key) === result) tails.delete(key);
  }
}

export async function createEntry(root: string, path: string, kind: 'file' | 'directory'): Promise<void> {
  return fileOperation(root, async () => {
    const target = await mutablePath(root, path);
    try {
      if (kind === 'directory') await fs.mkdir(target);
      else { const handle = await fs.open(target, 'wx', 0o644); await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('An item already exists at this path. Choose another name.');
      throw error;
    }
  });
}

export async function moveFile(root: string, from: string, to: string): Promise<void> {
  return fileOperation(root, async () => {
    const source = await mutablePath(root, from, true);
    const target = await mutablePath(root, to);
    if (source === target) return;
    const before = await fs.lstat(source);
    if (before.isDirectory()) {
      // Directories cannot be hardlinked; verify the destination is free, then rename
      // (same volume only, and this is not atomic against a concurrent create — best effort).
      let exists = true;
      try { await fs.lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error; }
      if (exists) throw new Error('Destination already exists. Nothing was replaced.');
      try { await fs.rename(source, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('Move within the same disk, or use your file manager.');
        throw error;
      }
      return;
    }
    if (!before.isFile()) throw new Error('Only files and folders can be moved from the file pane.');
    // Exclusive creation: unlike rename(), link() never replaces an existing target.
    // Same-volume only; cross-volume moves fail without changing the source.
    try { await fs.link(source, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Destination already exists. Nothing was replaced.');
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error('Move within the same disk, or use your file manager.');
      throw error;
    }
    const current = await fs.lstat(source);
    if (current.ino !== before.ino || current.dev !== before.dev) throw new Error(`The source changed while moving. Both paths were kept; inspect ${to} before retrying.`);
    try { await fs.unlink(source); }
    catch { throw new Error(`Created ${to}, but could not remove the original. Both paths were kept.`); }
  });
}
