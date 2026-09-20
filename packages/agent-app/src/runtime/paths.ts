/**
 * Path confinement shared by files.* and git.* commands. `root` is the trusted
 * folder path from the store; `rel` always comes from the renderer and is
 * untrusted. Modeled on the reviewed agent-mode-review resolveInside.
 */
import { promises as fs } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** Resolve `rel` inside `root`, rejecting lexical and symlink escapes. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (rel.includes('\0')) throw new Error('Path contains NUL.');
  const realRoot = await fs.realpath(root);
  const candidate = resolve(realRoot, rel);
  // Lexical containment first: rejects `..` escapes even for nonexistent paths.
  if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) {
    throw new Error(`Path escapes folder root: ${rel}`);
  }
  // Physical containment: a symlink inside the tree must not point outside it.
  try {
    const real = await fs.realpath(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`Path resolves outside folder root: ${rel}`);
    }
    return real;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A missing leaf can still have an existing symlink parent outside root.
      let parent = dirname(candidate);
      while (parent !== realRoot) {
        try {
          const real = await fs.realpath(parent);
          if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('Path resolves outside folder root.');
          break;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError;
          const link = await fs.lstat(parent).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
          if (link?.isSymbolicLink()) throw new Error('Path contains an unresolved symlink.');
          const next = dirname(parent);
          if (next === parent) throw new Error('Folder root is unavailable.');
          parent = next;
        }
      }
      return candidate;
    }
    throw error;
  }
}
