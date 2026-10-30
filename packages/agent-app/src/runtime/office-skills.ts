/**
 * #772-#775: Muster's own skills for documents, spreadsheets, presentations and PDF. They ship with the app
 * (resources/skills, copied to dist/runtime/resources/skills by the build) and are installed into Muster's own
 * coding-client home, where they take the place of any other app's skills for the same file types.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { unpackedPath } from './unpacked-path.ts';

/** Muster's skills, by folder name (also their `name:`). */
export const MUSTER_OFFICE_SKILLS = ['documents', 'spreadsheets', 'presentations', 'pdf'] as const;
const STAMP = '.muster-skill';

/** The folder holding Muster's skills: dist/runtime/resources/skills in the app (the runtime runs from dist/main), resources/skills in a checkout. */
export function musterSkillsDir(here: string = typeof __dirname === 'string' ? __dirname : join(process.cwd(), 'src', 'runtime')): string {
  const candidates = [join(here, 'resources', 'skills'), join(here, '..', 'runtime', 'resources', 'skills'), join(here, '..', '..', 'resources', 'skills'), join(process.cwd(), 'resources', 'skills')];
  for (const candidate of candidates) {
    const path = unpackedPath(candidate);
    if (existsSync(join(path, 'documents', 'SKILL.md'))) return path;
  }
  return unpackedPath(candidates[0]!);
}

function files(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === STAMP) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...files(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
function digest(dir: string): string {
  const hash = createHash('sha256');
  for (const rel of files(dir)) hash.update(rel).update('\0').update(readFileSync(join(dir, rel))).update('\0');
  return hash.digest('hex');
}

/** Copies each of Muster's skills into `skillsDir/<name>`, replacing a link or an older copy; an unchanged copy is left alone. */
export function installMusterSkills(source: string, skillsDir: string, names: Iterable<string> = MUSTER_OFFICE_SKILLS): string[] {
  const installed: string[] = [];
  mkdirSync(skillsDir, { recursive: true });
  for (const name of names) {
    const from = join(source, name), to = join(skillsDir, name);
    if (!existsSync(join(from, 'SKILL.md'))) continue;
    const want = digest(from);
    try {
      let current: ReturnType<typeof lstatSync> | undefined;
      try { current = lstatSync(to); } catch { current = undefined; }
      if (current?.isSymbolicLink()) unlinkSync(to);
      else if (current?.isDirectory()) {
        let stamp = '';
        try { stamp = readFileSync(join(to, STAMP), 'utf8').trim(); } catch { /* not ours yet */ }
        if (stamp === want) { installed.push(name); continue; }
        rmSync(to, { recursive: true, force: true });
      } else if (current) rmSync(to, { force: true });
      cpSync(from, to, { recursive: true });
      writeFileSync(join(to, STAMP), want);
      installed.push(name);
    } catch { /* this skill stays as it was; the note still names the shipped copy */ }
  }
  return installed;
}

/** Whether `dir` is a copy installMusterSkills made (so it is never mistaken for one of the person's skills). */
export function isMusterSkillCopy(dir: string): boolean {
  try { return statSync(join(dir, STAMP)).isFile(); } catch { return false; }
}
