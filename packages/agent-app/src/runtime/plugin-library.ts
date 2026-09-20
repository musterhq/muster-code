/** Bounded, read-only inventory of local skills. No installation or execution. */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface SkillEntry {
  id: string;
  name: string;
  provenance: string;
  path: string;
  readme: string | null;
  readError: string | null;
}

const MAX_README = 65536;
const MAX_ENTRIES = 200;
const ROOTS = (folderPaths: string[]) => [
  { path: join(homedir(), '.agents', 'skills'), provenance: '~/.agents/skills' },
  { path: join(homedir(), '.codex', 'skills'), provenance: '~/.codex/skills' },
  { path: join(homedir(), '.omp', 'agent', 'skills'), provenance: '~/.omp/agent/skills' },
  ...folderPaths.map(path => ({ path: join(path, '.agents', 'skills'), provenance: `.agents/skills (${basename(path)})` })),
];

async function contained(path: string, root: string): Promise<string | null> {
  try {
    const resolved = await fs.realpath(path);
    return resolved === root || resolved.startsWith(`${root}/`) ? resolved : null;
  } catch { return null; }
}

async function readSkill(dir: string, root: string): Promise<{ readme: string | null; readError: string | null }> {
  const path = await contained(join(dir, 'SKILL.md'), root);
  if (!path) return { readme: null, readError: null };
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return { readme: null, readError: null };
    const handle = await fs.open(path, 'r');
    try {
      const buffer = Buffer.alloc(MAX_README);
      const { bytesRead } = await handle.read(buffer, 0, MAX_README, 0);
      return { readme: buffer.subarray(0, bytesRead).toString('utf8'), readError: null };
    } finally { await handle.close(); }
  } catch (error) { return { readme: null, readError: error instanceof Error ? error.message : String(error) }; }
}

export async function discoverSkills(folderPaths: string[] = []): Promise<SkillEntry[]> {
  const output: SkillEntry[] = [];
  for (const source of ROOTS(folderPaths)) {
    if (output.length >= MAX_ENTRIES) break;
    let root: string;
    try {
      root = await fs.realpath(source.path);
      if (!(await fs.stat(root)).isDirectory()) continue;
    } catch { continue; }
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (output.length >= MAX_ENTRIES || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const dir = await contained(join(root, entry.name), root);
      if (!dir) continue;
      try { if (!(await fs.stat(dir)).isDirectory()) continue; } catch { continue; }
      const read = await readSkill(dir, root);
      output.push({ id: dir, name: basename(dir), provenance: source.provenance, path: dir, ...read });
    }
  }
  return output;
}
