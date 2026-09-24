/**
 * "Record a skill": writes a user-authored skill into ~/.codex/skills/<slug>/ so
 * discoverSkills() lists it immediately. Only a validated slug directory directly
 * under the skills root is ever touched; symlinks and replacements are refused
 * unless the caller confirmed the overwrite.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_ATTACHED_SKILL_BYTES } from '../shared/protocol.ts';

export const SKILL_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Lowercase words joined by single dashes; empty when nothing usable remains. */
export function skillSlug(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}
const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
/** YAML-safe scalar: JSON strings are valid double-quoted YAML. */
const scalar = (value: string) => JSON.stringify(value);

export function skillMarkdown(input: { slug: string; description: string; body: string }): string {
  const body = input.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  return `---\nname: ${input.slug}\ndescription: ${scalar(oneLine(input.description))}\n---\n\n${body}\n`;
}
export function skillInterfaceYaml(input: { name: string; description: string }): string {
  return `interface:\n  display_name: ${scalar(oneLine(input.name))}\n  short_description: ${scalar(oneLine(input.description))}\n`;
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  await fs.writeFile(temp, text, { mode: 0o644, flag: 'wx' });
  try { await fs.rename(temp, path); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

export async function createSkill(input: { name: string; description: string; body: string; overwrite?: boolean }, home = homedir()): Promise<{ id: string; slug: string; path: string; replaced: boolean }> {
  const name = oneLine(input.name ?? '');
  const description = oneLine(input.description ?? '');
  const body = (input.body ?? '').trim();
  if (!name || name.length > 80) throw new Error('Name the skill (up to 80 characters).');
  const slug = skillSlug(name);
  if (!SKILL_SLUG.test(slug)) throw new Error('Use letters or numbers in the skill name.');
  if (!description || description.length > 300) throw new Error('Describe when to use the skill (up to 300 characters).');
  if (!body) throw new Error('Write the skill instructions.');
  const markdown = skillMarkdown({ slug, description, body });
  if (Buffer.byteLength(markdown) > MAX_ATTACHED_SKILL_BYTES) throw new Error('Keep the skill under 48 KB so it can be attached to a message.');
  if ([name, description, body].some(value => value.includes('\0'))) throw new Error('The skill contains invalid characters.');
  const root = join(home, '.codex', 'skills');
  await fs.mkdir(root, { recursive: true, mode: 0o755 });
  const realRoot = await fs.realpath(root);
  const dir = join(realRoot, slug);
  let replaced = false;
  try {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`“${slug}” exists in ~/.codex/skills but is not a plain skill folder. Choose another name.`);
    if (!input.overwrite) throw new Error(`A skill named “${slug}” already exists. Replace it?`);
    replaced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await fs.mkdir(dir, { mode: 0o755 });
  }
  if (await fs.realpath(dir) !== join(realRoot, slug)) throw new Error('The skill folder resolved outside ~/.codex/skills.');
  await fs.mkdir(join(dir, 'agents'), { recursive: true, mode: 0o755 });
  const agents = join(dir, 'agents');
  if ((await fs.lstat(agents)).isSymbolicLink()) throw new Error('The skill folder resolved outside ~/.codex/skills.');
  await writeAtomic(join(dir, 'SKILL.md'), markdown);
  await writeAtomic(join(agents, 'openai.yaml'), skillInterfaceYaml({ name, description }));
  return { id: dir, slug, path: join(dir, 'SKILL.md'), replaced };
}
