/** Agent instruction bundle (G11): validation and composition of the files a run receives. */
import { BUNDLE_FILE_NAME, BUNDLE_LIMITS, BUNDLE_MAIN, type BundleFile } from '../../shared/domains/project-governance-protocol.ts';

export function validateFile(name: unknown, text: unknown): { name: string; text: string } {
  if (typeof name !== 'string' || !BUNDLE_FILE_NAME.test(name)) throw new Error('A file name is letters, digits, dots, dashes or underscores, ends in .md and is up to 64 characters.');
  if (typeof text !== 'string' || text.includes('\0')) throw new Error('The file text is not valid.');
  if (text.length > BUNDLE_LIMITS.maxFileChars) throw new Error(`${name} is over ${BUNDLE_LIMITS.maxFileChars.toLocaleString('en-US')} characters.`);
  return { name, text };
}
export function checkBundle(files: readonly { name: string; text: string }[]): void {
  if (files.length > BUNDLE_LIMITS.maxFiles) throw new Error(`An agent's bundle holds up to ${BUNDLE_LIMITS.maxFiles} files.`);
  const total = files.reduce((n, f) => n + f.text.length, 0);
  if (total > BUNDLE_LIMITS.maxTotalChars) throw new Error(`The bundle is over ${BUNDLE_LIMITS.maxTotalChars.toLocaleString('en-US')} characters in total.`);
}
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
/** The prompt text of an agent's bundle. AGENTS.md leads; SOUL.md and TOOLS.md ride with every run; HEARTBEAT.md only on a timer wake; any other file is listed by name only. */
export function composeBundle(files: readonly BundleFile[], opts: { timer: boolean; name: string }): string[] {
  const get = (n: string) => files.find(f => f.name === n)?.text.trim() ?? '';
  const out: string[] = [];
  if (get(BUNDLE_MAIN)) out.push(`${opts.name}'s instructions — follow these:`, clip(get(BUNDLE_MAIN), 6000));
  if (get('SOUL.md')) out.push('', 'Persona (SOUL.md):', clip(get('SOUL.md'), 3000));
  if (get('TOOLS.md')) out.push('', 'Tools and environment notes (TOOLS.md):', clip(get('TOOLS.md'), 3000));
  if (opts.timer && get('HEARTBEAT.md')) out.push('', 'This run was started by your heartbeat timer. Work through this checklist (HEARTBEAT.md):', clip(get('HEARTBEAT.md'), 3000));
  const extra = files.filter(f => !['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'HEARTBEAT.md'].includes(f.name) && f.text.trim()).map(f => f.name);
  if (extra.length) out.push('', `More notes in your bundle (ask the user if you need them): ${extra.join(', ')}.`);
  return out;
}
/** Names whose text differs between two file maps. */
export function changedNames(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter(n => before[n] !== after[n]).sort();
}
