/** Clone sheet reviewer fixes: "Choose…" picks a parent folder, SSH host-key failures read clearly, the timeout message survives. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {cloneErrorMessage, defaultDestination, sshHost} from '../src/runtime/git-clone.ts';
import {destinationInParent, parentFolder} from '../src/renderer/cloneDestination.ts';

const dir = realpathSync(await mkdtemp(join(tmpdir(), 'muster-clone-fix-')));
after(() => rm(dir, {recursive: true, force: true}));

test('a picked parent (like ~/Code) gets the repository folder appended, stepping past an existing one', async () => {
  const code = join(dir, 'Code');
  await mkdir(code, {recursive: true});
  assert.deepEqual(await defaultDestination('git@github.com:o/widgets.git', code), {path: join(code, 'widgets'), name: 'widgets'});
  await mkdir(join(code, 'widgets'));
  assert.equal((await defaultDestination('https://github.com/o/widgets', code)).path, join(code, 'widgets-2'));
  await assert.rejects(defaultDestination('https://github.com/o/widgets', 'relative\0bad'), /destination/);

  // Renderer side: the runtime names the folder; before a URL is valid the current folder name is kept.
  const resolveName = async ({url, parent}: {url: string; parent: string}) => defaultDestination(url, parent);
  assert.equal(await destinationInParent(code, 'https://github.com/o/other.git', '', resolveName), join(code, 'other'));
  assert.equal(await destinationInParent('/Users/me/Code', 'not a url', '/Users/me/Projects/widgets', resolveName), '/Users/me/Code/widgets');
  assert.equal(await destinationInParent('/Users/me/Code/', '', '', resolveName), '/Users/me/Code/repository');
  assert.equal(parentFolder('/Users/me/Code/widgets'), '/Users/me/Code');
  assert.equal(parentFolder('/Users/me/Code/widgets/'), '/Users/me/Code');
});

test('an untrusted SSH host key says how to trust it; the timeout keeps its own message; other errors use the git table', () => {
  const hostKey = cloneErrorMessage('Host key verification failed.\nfatal: Could not read from remote repository.', 'git@github.com:o/r.git', 128);
  assert.match(hostKey, /^Host key not trusted — run `ssh git@github.com` once in a terminal/);
  assert.match(cloneErrorMessage('No ED25519 host key is known for git.example.com and you have requested strict checking.\nHost key verification failed.', 'ssh://git.example.com:2222/o/r', 128), /run `ssh git\.example\.com`/);
  assert.match(cloneErrorMessage('fatal: early EOF\nClone timed out after 30 minutes.', 'https://github.com/o/r', null, true), /^Clone timed out after 30 minutes/);
  assert.match(cloneErrorMessage('fatal: Could not resolve host: github.com', 'https://github.com/o/r', 128), /Can’t reach the remote/);
  assert.equal(sshHost('git@github.com:o/r.git'), 'github.com');
  assert.equal(sshHost('ssh://git@host.example/o/r'), 'host.example');
  assert.equal(sshHost('https://github.com/o/r'), undefined);
});
