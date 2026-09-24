#!/usr/bin/env node
// Re-copies the external Muster core sources that scripts/build.mjs bundles into vendor/, so a fresh
// clone builds with no sibling checkouts and no env vars. Run it only when you have the checkouts and
// want to move the vendored snapshot forward:
//
//   MUSTER_CORE_CLIENT_ENTRY=/path/to/muster/packages/core/src/codex-app-server.ts \
//   MUSTER_RUNTIME_SOURCE_ROOT=/path/to/muster \
//   MUSTER_SANDBOX_SOURCE_ROOT=/path/to/muster-scoped-checkout \
//   npm run vendor:sync
//
// Only the groups whose env var is set are refreshed; the others keep their current snapshot. The file
// set is not hand-maintained: esbuild resolves each entry's transitive imports and exactly those files
// are copied, at the same path relative to the checkout root, so relative imports keep working.
// Provenance (remote, branch, commit, uncommitted files, sha256) goes to vendor/SOURCES.json and the
// table in vendor/README.md.
import * as esbuild from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
const manifestPath = path.join(vendor, 'SOURCES.json');

/** Each group is one vendored checkout. `entries` are relative to the checkout root. */
const GROUPS = [
  {
    name: 'muster-core',
    purpose: 'Lifecycle-aware Codex app-server client (CODEX_RUN_LIFECYCLE_VERSION=1, steerActiveCodexTurn) -> dist/runtime/core-client.cjs',
    env: 'MUSTER_CORE_CLIENT_ENTRY',
    // The env var names the entry file itself; the checkout root is four levels up.
    rootFromEnv: value => path.resolve(value, '../../../..'),
    entries: ['packages/core/src/codex-app-server.ts'],
  },
  {
    name: 'muster-runtime',
    purpose: 'Memory and Hindsight stores -> dist/runtime/core-memory.cjs, core-hindsight.cjs',
    env: 'MUSTER_RUNTIME_SOURCE_ROOT',
    rootFromEnv: value => path.resolve(value),
    entries: ['packages/core/src/memory.ts', 'packages/core/src/hindsight.ts'],
  },
  {
    name: 'muster-sandbox',
    purpose: 'Local Docker sandbox and scoped runtime -> dist/runtime/scoped-computer-core.cjs',
    env: 'MUSTER_SANDBOX_SOURCE_ROOT',
    rootFromEnv: value => path.resolve(value),
    entries: ['packages/core/src/local-docker-sandbox.ts', 'packages/core/src/scoped-runtime.ts'],
  },
];

function git(cwd, ...args) {
  // trimEnd only: porcelain status lines start with a significant space (" M path").
  try { return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trimEnd(); }
  catch { return null; }
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

async function transitiveInputs(checkout, entries) {
  const result = await esbuild.build({
    entryPoints: entries.map(entry => path.join(checkout, entry)),
    bundle: true, write: false, platform: 'node', format: 'cjs', outdir: path.join(vendor, '.probe'),
    metafile: true, logLevel: 'error', absWorkingDir: checkout,
  });
  const files = Object.keys(result.metafile.inputs).map(input => path.resolve(checkout, input));
  const outside = files.filter(file => path.relative(checkout, file).startsWith('..'));
  if (outside.length) throw new Error(`Entries import files outside ${checkout}:\n  ${outside.join('\n  ')}`);
  const packages = files.filter(file => file.includes(`${path.sep}node_modules${path.sep}`));
  if (packages.length) throw new Error(`Entries pull npm packages the agent app does not depend on:\n  ${packages.join('\n  ')}`);
  return files.map(file => path.relative(checkout, file)).sort();
}

const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {groups: {}};
const selected = GROUPS.filter(group => process.env[group.env]);
if (!selected.length) {
  console.log(`Nothing to sync: set one or more of ${GROUPS.map(group => group.env).join(', ')}. vendor/ is unchanged.`);
  process.exit(0);
}

for (const group of selected) {
  const checkout = group.rootFromEnv(process.env[group.env]);
  for (const entry of group.entries) {
    if (!existsSync(path.join(checkout, entry))) throw new Error(`${group.env} -> ${checkout} has no ${entry}.`);
  }
  const files = await transitiveInputs(checkout, group.entries);
  const target = path.join(vendor, group.name);
  rmSync(target, {recursive: true, force: true});
  for (const file of files) {
    mkdirSync(path.dirname(path.join(target, file)), {recursive: true});
    cpSync(path.join(checkout, file), path.join(target, file));
  }
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(name => existsSync(path.join(checkout, name)));
  if (!license) throw new Error(`${checkout} has no LICENSE file; refusing to vendor unlicensed source.`);
  cpSync(path.join(checkout, license), path.join(target, 'LICENSE'));

  const commit = git(checkout, 'rev-parse', 'HEAD');
  const dirty = commit ? (git(checkout, 'status', '--porcelain', '--', ...files) || '').split('\n').filter(Boolean).map(line => line.slice(3)) : [];
  manifest.groups[group.name] = {
    purpose: group.purpose,
    env: group.env,
    remote: commit ? git(checkout, 'remote', 'get-url', 'origin') : null,
    branch: commit ? (git(checkout, 'branch', '--show-current') || '(detached HEAD)') : null,
    commit: commit || null,
    // A non-git source has no remote to point at; keep where it was copied from (a machine-local path).
    // Only the folder name: an absolute path would record one machine's layout in the repository.
    sourcePath: commit ? null : path.basename(checkout),
    note: commit ? (dirty.length ? 'Includes uncommitted working-tree changes in the files listed under uncommittedFiles.' : 'Clean at the recorded commit.')
      : 'Source checkout is not a git repository; the sha256 values below are the only provenance.',
    uncommittedFiles: dirty,
    syncedAt: new Date().toISOString(),
    files: Object.fromEntries(files.map(file => [file, sha256(path.join(target, file))])),
  };
  console.log(`vendor/${group.name}: ${files.length} files from ${checkout}${commit ? ` @ ${commit.slice(0, 12)}` : ' (no git)'}${dirty.length ? ` + ${dirty.length} uncommitted` : ''}`);
}
rmSync(path.join(vendor, '.probe'), {recursive: true, force: true});
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeReadme();

function writeReadme() {
  const rows = GROUPS.filter(group => manifest.groups[group.name]).map(group => {
    const info = manifest.groups[group.name];
    const files = Object.keys(info.files).map(file => `\`${file}\``).join('<br>');
    const origin = info.commit ? `${info.remote || '(no remote)'}<br>branch \`${info.branch}\`<br>commit \`${info.commit}\`` : `local checkout, not a git repository (\`${info.sourcePath}\`)`;
    const uncommitted = info.uncommittedFiles.length ? `<br>**plus uncommitted changes:** ${info.uncommittedFiles.map(file => `\`${file}\``).join(', ')}` : '';
    return `| \`vendor/${group.name}\` | \`${info.env}\` | ${origin}${uncommitted} | ${info.syncedAt.slice(0, 10)} | ${files} |`;
  });
  writeFileSync(path.join(vendor, 'README.md'), `# Vendored Muster core sources

\`scripts/build.mjs\` bundles a few TypeScript modules from the Muster core (github.com/Dkm0315/muster,
MIT licensed, see each directory's \`LICENSE\` and \`licenses/muster-core-MIT.txt\`). They are vendored
here so a fresh clone builds with \`npm ci && npm start\`: no sibling checkouts, no env vars.

Resolution order in \`scripts/build.mjs\`, per group: the env var if it is set, otherwise \`vendor/<group>\`.
The layout under each group mirrors the source checkout (\`packages/core/src/...\`), so relative imports
are unchanged and a group directory is a drop-in for the checkout root.

Do not edit these files by hand. Fix them upstream, then refresh the snapshot:

\`\`\`sh
MUSTER_CORE_CLIENT_ENTRY=/path/to/core/packages/core/src/codex-app-server.ts \\
MUSTER_RUNTIME_SOURCE_ROOT=/path/to/muster \\
MUSTER_SANDBOX_SOURCE_ROOT=/path/to/scoped-checkout \\
npm run vendor:sync
\`\`\`

Only groups whose env var is set are refreshed. The file list is computed by esbuild from each entry's
transitive imports. Exact hashes are in \`SOURCES.json\`.

| Directory | Override env var | Origin | Synced | Files |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

Group purposes:

${GROUPS.filter(group => manifest.groups[group.name]).map(group => `- \`${group.name}\`: ${group.purpose}`).join('\n')}
`);
}
