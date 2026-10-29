/** #729: a Claude Code command is read only from inside its commands folder, even when a folder on its path is swapped for a link
 *  while it is read. macOS refuses the link at open time (O_NOFOLLOW_ANY); Linux checks the kernel's path for the opened file. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, rm, writeFile, realpath, symlink, stat} from 'node:fs/promises';
import {promises as fsPromises} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discoverSkills, resolveAttachedSkill} from '../src/runtime/plugin-library.ts';

// Spec: MUS-SPEC-14-732I (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-732i)
test('a command folder swapped for a link to an outside folder while it is read is refused, even if every check sees the folder restored', {skip: process.platform === 'win32' && 'Windows links need admin rights; see 732A'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'muster-732i-')), saved = process.env.HOME, originalRealpath = fsPromises.realpath, originalLstat = fsPromises.lstat;
  process.env.HOME = join(root, 'home');
  const commands = join(root, 'home', '.claude', 'commands'), outside = join(root, 'outside');
  await mkdir(join(commands, 'team'), {recursive: true}); await mkdir(outside);
  await writeFile(join(commands, 'team', 'review.md'), 'TEAM-REVIEW-BODY\n');
  await writeFile(join(commands, 'plain.md'), 'PLAIN-BODY\n');
  await writeFile(join(outside, 'review.md'), 'SECRET-OUTSIDE-THE-COMMANDS-FOLDER\n');
  const inside = await realpath(join(commands, 'team', 'review.md')), secretStat = await stat(join(outside, 'review.md'));
  t.after(async () => { fsPromises.realpath = originalRealpath; fsPromises.lstat = originalLstat; if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; await rm(root, {recursive: true, force: true}); });

  // Control: untouched, both commands are listed and attach with their own text.
  const before = await discoverSkills([]);
  assert.match(before.find(entry => entry.name === 'team:review')?.readme ?? '', /TEAM-REVIEW-BODY/, 'the untouched command is listed with its text');
  assert.match((await resolveAttachedSkill(inside, []))?.content ?? '', /TEAM-REVIEW-BODY/, 'the untouched command attaches with its text');

  // The racer keeps team/ as a link to the outside folder, but restores it whenever the reader resolves or lstats the path.
  await rm(join(commands, 'team'), {recursive: true}); await symlink(outside, join(commands, 'team'));
  fsPromises.realpath = (async (...args: Parameters<typeof originalRealpath>) => String(args[0]) === inside ? inside : originalRealpath(...args)) as typeof originalRealpath;
  fsPromises.lstat = (async (...args: Parameters<typeof originalLstat>) => String(args[0]) === inside ? secretStat : originalLstat(...args)) as typeof originalLstat;
  const during = await discoverSkills([]);
  assert.doesNotMatch(during.find(entry => entry.name === 'team:review')?.readme ?? '', /SECRET/, 'the picker never shows the outside file');
  assert.doesNotMatch((await resolveAttachedSkill(inside, []))?.content ?? '', /SECRET/, 'a run never gets the outside file');
  assert.match(during.find(entry => entry.name === 'plain')?.readme ?? '', /PLAIN-BODY/, 'a command the swap does not touch still reads');
});
