/**
 * Local skill authoring in ~/.agents/skills/<name>/SKILL.md. Every save first copies the
 * previous SKILL.md into <name>/.history/<timestamp>.md, so edits can be restored.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_ATTACHED_SKILL_BYTES } from '../shared/protocol.ts';
import type { LocalSkill, LocalSkillDraft } from '../shared/domains/extensions-protocol.ts';

export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HISTORY = '.history', MAX_HISTORY = 20, MAX_ASSETS = 200;
export const skillsHome = (home = homedir()) => join(home, '.agents', 'skills');
const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

export function composeSkill(draft: LocalSkillDraft): string {
  const body = draft.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  return `---\nname: ${draft.name}\ndescription: ${JSON.stringify(oneLine(draft.description))}\n---\n\n${body}\n`;
}
export function parseSkill(name: string, text: string): LocalSkillDraft {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const raw = match ? /^description\s*:\s*(.*)$/m.exec(match[1])?.[1]?.trim() ?? '' : '';
  let description = raw;
  if (/^".*"$/.test(raw)) { try { description = JSON.parse(raw) as string; } catch { description = raw.slice(1, -1); } }
  else if (/^'.*'$/.test(raw)) description = raw.slice(1, -1).replace(/''/g, "'");
  return { name, description, body: (match ? text.slice(match[0].length) : text).trim() };
}

async function skillDir(name: string, home: string, create = false): Promise<string> {
  if (!SKILL_NAME.test(name)) throw new Error('Use lowercase letters, numbers and dashes for the skill name.');
  const root = skillsHome(home);
  if (create) await fs.mkdir(root, { recursive: true });
  const real = await fs.realpath(root);
  const dir = join(real, name);
  try { const stat = await fs.lstat(dir); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`~/.agents/skills/${name} is not a plain skill folder.`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error; await fs.mkdir(dir); }
  return dir;
}
async function assets(dir: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of (await fs.readdir(current, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (output.length >= MAX_ASSETS || entry.name === HISTORY || entry.name === '.DS_Store' || entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && path !== join(dir, 'SKILL.md')) output.push(relative(dir, path).split(sep).join('/'));
    }
  };
  await walk(dir, 0);
  return output;
}
async function history(dir: string): Promise<LocalSkill['history']> {
  const names = (await fs.readdir(join(dir, HISTORY)).catch(() => [] as string[])).filter(name => /^\d{13}-[a-f0-9]{8}\.md$/.test(name)).sort().reverse();
  return names.map(name => ({ id: name.slice(0, -3), savedAt: new Date(Number(name.slice(0, 13))).toISOString() }));
}

export async function readLocalSkill(name: string, home = homedir()): Promise<LocalSkill> {
  const dir = await skillDir(name, home);
  const text = await fs.readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => '');
  return { ...parseSkill(name, text), path: join(dir, 'SKILL.md'), assets: await assets(dir), history: await history(dir) };
}

async function snapshot(dir: string): Promise<void> {
  const previous = await fs.readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => null);
  if (previous === null) return;
  await fs.mkdir(join(dir, HISTORY), { recursive: true });
  await fs.writeFile(join(dir, HISTORY, `${Date.now()}-${randomUUID().slice(0, 8)}.md`), previous, { flag: 'wx' });
  const old = (await history(dir)).slice(MAX_HISTORY);
  await Promise.all(old.map(entry => fs.rm(join(dir, HISTORY, `${entry.id}.md`), { force: true })));
}
async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, text, { flag: 'wx' });
  try { await fs.rename(temp, path); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

/** Create or edit a skill. Renaming moves the folder (assets and history travel with it). */
export async function saveLocalSkill(input: LocalSkillDraft & { previousName?: string }, home = homedir()): Promise<LocalSkill> {
  const name = input.name?.trim() ?? '', description = oneLine(input.description ?? ''), body = (input.body ?? '').trim();
  if (!SKILL_NAME.test(name)) throw new Error('Use lowercase letters, numbers and dashes for the skill name.');
  if (!description || description.length > 1024) throw new Error('Describe when to use the skill (up to 1024 characters).');
  if (!body) throw new Error('Write the skill instructions.');
  if ([name, description, body].some(value => value.includes('\0'))) throw new Error('The skill contains invalid characters.');
  const text = composeSkill({ name, description, body });
  if (Buffer.byteLength(text) > MAX_ATTACHED_SKILL_BYTES) throw new Error(`Keep SKILL.md under ${Math.floor(MAX_ATTACHED_SKILL_BYTES / 1024)} KB so it can be attached.`);
  if (input.previousName && input.previousName !== name) {
    const from = await skillDir(input.previousName, home);
    const to = join(skillsHome(home), name);
    try { await fs.lstat(to); throw new Error(`A skill named “${name}” already exists.`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.rename(from, to);
  }
  const dir = await skillDir(name, home, true);
  if (input.previousName === undefined && await fs.readFile(join(dir, 'SKILL.md'), 'utf8').then(() => true, () => false)) throw new Error(`A skill named “${name}” already exists. Open it to edit.`);
  await snapshot(dir);
  await writeAtomic(join(dir, 'SKILL.md'), text);
  return readLocalSkill(name, home);
}

/** Restore a history copy; the current text is itself snapshotted first. */
export async function restoreLocalSkill(name: string, historyId: string, home = homedir()): Promise<LocalSkill> {
  if (!/^\d{13}-[a-f0-9]{8}$/.test(historyId)) throw new Error('Unknown version.');
  const dir = await skillDir(name, home);
  const text = await fs.readFile(join(dir, HISTORY, `${historyId}.md`), 'utf8');
  await snapshot(dir);
  await writeAtomic(join(dir, 'SKILL.md'), text);
  return readLocalSkill(name, home);
}
