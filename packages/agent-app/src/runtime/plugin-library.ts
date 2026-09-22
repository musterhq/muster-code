/** Bounded, read-only inventory of local skills and installed plugin manifests. */
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

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  provenance: string;
  path: string;
  skills: string[];
  mcpServers: Array<{ name: string; transport: 'local' | 'remote' | 'unknown' }>;
  apps: Array<{ name: string; id: string; required: boolean; category?: string }>;
  readError: string | null;
}

const MAX_README = 65536;
const MAX_ENTRIES = 200;
const MAX_MANIFEST = 262144;
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readJson(path: string, root: string): Promise<Record<string, unknown> | null> {
  const safe = await contained(path, root);
  if (!safe) return null;
  const stat = await fs.stat(safe);
  if (!stat.isFile() || stat.size > MAX_MANIFEST) throw new Error(`${basename(path)} is not a bounded file.`);
  return record(JSON.parse(await fs.readFile(safe, 'utf8')));
}

async function directoryNames(path: string, root: string): Promise<string[]> {
  const safe = await contained(path, root);
  if (!safe) return [];
  try {
    return (await fs.readdir(safe, {withFileTypes:true}))
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort((a,b)=>a.localeCompare(b));
  } catch { return []; }
}

/**
 * Inspect installed Codex plugin bundles without executing manifests or
 * exposing command arguments, environment variables, URLs, or credentials.
 */
export async function discoverPlugins(): Promise<PluginEntry[]> {
  const cachePath = join(homedir(), '.codex', 'plugins', 'cache');
  let root: string;
  try {
    root = await fs.realpath(cachePath);
    if (!(await fs.stat(root)).isDirectory()) return [];
  } catch { return []; }
  const output: PluginEntry[] = [];
  for (const provenance of await directoryNames(root, root)) {
    const provenanceDir = await contained(join(root, provenance), root);
    if (!provenanceDir) continue;
    for (const pluginName of await directoryNames(provenanceDir, root)) {
      const pluginDir = await contained(join(provenanceDir, pluginName), root);
      if (!pluginDir) continue;
      for (const version of await directoryNames(pluginDir, root)) {
        if (output.length >= MAX_ENTRIES) return output;
        const dir = await contained(join(pluginDir, version), root);
        if (!dir) continue;
        let readError: string | null = null;
        let lock: Record<string, unknown> | null = null;
        let mcp: Record<string, unknown> | null = null;
        let app: Record<string, unknown> | null = null;
        try { lock = await readJson(join(dir, 'plugin.lock.json'), root); } catch(error) { readError = error instanceof Error ? error.message : String(error); }
        try { mcp = await readJson(join(dir, '.mcp.json'), root); } catch(error) { readError ??= error instanceof Error ? error.message : String(error); }
        try { app = await readJson(join(dir, '.app.json'), root); } catch(error) { readError ??= error instanceof Error ? error.message : String(error); }
        const lockedSkills = Array.isArray(lock?.skills) ? lock.skills.flatMap(value => {
          const row=record(value); return typeof row?.id === 'string' ? [row.id] : [];
        }) : [];
        const skills = lockedSkills.length ? lockedSkills : await directoryNames(join(dir, 'skills'), root);
        const mcpServers = Object.entries(record(mcp?.mcpServers) ?? {}).slice(0,64).map(([name,value])=>{
          const row=record(value); const remote=typeof row?.url==='string'||row?.type==='http'; const local=typeof row?.command==='string';
          return {name,transport:remote?'remote':local?'local':'unknown'} as const;
        });
        const apps = Object.entries(record(app?.apps) ?? {}).slice(0,128).flatMap(([name,value])=>{
          const row=record(value); if(typeof row?.id!=='string')return [];
          return [{name,id:row.id,required:row.required===true,...(typeof row.category==='string'?{category:row.category}:{})}];
        });
        if (!lock && !mcp && !app && !skills.length) continue;
        output.push({id:dir,name:pluginName,version,provenance,path:dir,skills,mcpServers,apps,readError});
      }
    }
  }
  return output.sort((a,b)=>a.name.localeCompare(b.name)||b.version.localeCompare(a.version));
}
