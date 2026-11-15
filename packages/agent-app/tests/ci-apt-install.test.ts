// #876: the Linux CI jobs install their apt packages through scripts/ci-apt-install.sh, which moves to another mirror when
// one fails. The real script runs under bash with a stand-in apt-get on PATH and the apt folders in a temp directory.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'ci-apt-install.sh');
const WORKFLOW = join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'agent-app-cross-platform.yml');
const MIRRORS = ['http://one.test/ubuntu/', 'http://two.test/ubuntu/', 'http://three.test/ubuntu/'];

/** A temp apt setup and a fake apt-get that fails as `behaviour` says for the mirror the sources point at. */
function fakeApt(behaviour: Record<string, 'update-fails' | 'install-fails' | 'works'>) {
  const dir = mkdtempSync(join(tmpdir(), 'muster-apt-'));
  const etc = join(dir, 'etc-apt'), bin = join(dir, 'bin'), log = join(dir, 'apt.log');
  mkdirSync(join(etc, 'sources.list.d'), {recursive: true}); mkdirSync(bin);
  writeFileSync(join(etc, 'sources.list.d', 'ubuntu.sources'), 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\nComponents: main universe\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\nComponents: main universe\n');
  writeFileSync(join(etc, 'sources.list'), 'deb http://archive.ubuntu.com/ubuntu/ noble main\n');
  const cases = Object.entries(behaviour).map(([mirror, what]) => `  *'${mirror}'*) what=${what} ;;`).join('\n');
  writeFileSync(join(bin, 'apt-get'), `#!/bin/bash
sources="$(cat "${etc}/sources.list.d/ubuntu.sources" "${etc}/sources.list")"
what=works
case "$sources" in
${cases}
esac
mirror="$(grep -m1 -o 'http://[a-z.]*/ubuntu/' "${etc}/sources.list.d/ubuntu.sources")"
echo "$mirror $*" >> "${log}"
for arg in "$@"; do
  if [ "$arg" = update ] && [ "$what" = update-fails ]; then echo "E: Failed to fetch $mirror" >&2; exit 100; fi
  if [ "$arg" = install ] && [ "$what" = install-fails ]; then echo "E: Unable to locate package xvfb" >&2; exit 100; fi
done
exit 0
`);
  chmodSync(join(bin, 'apt-get'), 0o755);
  const run = () => spawnSync('bash', [SCRIPT, 'xvfb', 'xauth'], {encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`, APT_ETC: etc, APT_MIRRORS: MIRRORS.join(' '), APT_RETRY_PAUSE: '0'}});
  const calls = () => readFileSync(log, 'utf8').trim().split('\n');
  return {etc, run, calls, cleanup: () => rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200})};
}

// Spec: MUS-SPEC-22-876A (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-876a)
test('the apt install moves to the next mirror when one cannot find a package, and fails only after every mirror', t => {
  const apt = fakeApt({'one.test': 'update-fails', 'two.test': 'install-fails'});
  t.after(apt.cleanup);
  const ok = apt.run();
  assert.equal(ok.status, 0, ok.stderr);
  const calls = apt.calls();
  assert.ok(calls.some(call => call.startsWith('http://one.test/ubuntu/') && / update/.test(call)), 'the first mirror was tried');
  assert.ok(calls.some(call => call.startsWith('http://two.test/ubuntu/') && / install /.test(call)), 'the second mirror was tried after the first one failed');
  assert.match(calls.at(-1)!, /^http:\/\/three\.test\/ubuntu\/ .*install .*xvfb xauth$/, 'the packages were installed from the third mirror');
  assert.ok(calls.filter(call => / update/.test(call)).every(call => /--error-on=any/.test(call)), 'a partial package-list refresh counts as a failure');
  const sources = readFileSync(join(apt.etc, 'sources.list.d', 'ubuntu.sources'), 'utf8');
  assert.doesNotMatch(sources, /archive\.ubuntu\.com|security\.ubuntu\.com/, 'every source points at the working mirror');
  assert.equal((sources.match(/three\.test/g) ?? []).length, 2);
  assert.match(readFileSync(join(apt.etc, 'sources.list'), 'utf8'), /^deb http:\/\/three\.test\/ubuntu\/ noble main$/m);

  const broken = fakeApt({'one.test': 'update-fails', 'two.test': 'install-fails', 'three.test': 'install-fails'});
  t.after(broken.cleanup);
  const failed = broken.run();
  assert.notEqual(failed.status, 0, 'the step fails when no mirror works');
  assert.match(failed.stderr, /Unable to locate package xvfb/, 'with apt’s own error');
  for (const mirror of MIRRORS) assert.ok(broken.calls().some(call => call.startsWith(mirror)), `${mirror} was tried`);
});

// Spec: MUS-SPEC-22-876B (docs/spec/clauses/22-engineering-standards.md#mus-spec-22-876b)
test('both Linux jobs install their apt packages through the retrying script', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const job = (name: string) => { const start = workflow.indexOf(`\n  ${name}:\n`); assert.ok(start >= 0, `job ${name}`); const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/); return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next); };
  const build = job('package'), container = job('ubuntu-24-04');
  assert.match(build, /ci-apt-install\.sh [^\n]*xvfb[^\n]*desktop-file-utils/, 'the Linux build job uses the script');
  assert.match(container, /ci-apt-install\.sh [^\n]*xvfb xauth desktop-file-utils/, 'the container job uses the script');
  for (const text of [build, container]) assert.doesNotMatch(text, /apt-get[^\n]*install -y --no-install-recommends (?:build-essential|xvfb)/, 'no direct apt-get install of the build packages');
});
