import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateCloneUrl} from '../src/runtime/git-clone.ts';
import {redactGitText} from '../src/runtime/git-local.ts';
import {normalizeGitUrl} from '../src/runtime/plugin-install.ts';

// Obviously fake credentials.
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

test('clone URLs whose username is a token are rejected', () => {
  const bad = [
    `https://${TOKEN}@github.com/o/r.git`,
    'https://github_pat_FAKEFAKEFAKEFAKEFAKE_fakefake@github.com/o/r.git',
    'https://glpat-FAKEFAKEFAKE@gitlab.com/o/r.git',
    'https://gho_FAKEFAKE@github.com/o/r.git',
    'https://x-access-token:@github.com/o/r.git',
    'https://oauth2:@gitlab.com/o/r.git',
    'https://x-token-auth@bitbucket.org/o/r.git',
    `https://${TOKEN.replace('_', '%5F')}@github.com/o/r.git`,
    'https://0123456789abcdef0123456789abcdef01234567@host.example/o/r.git',
    'http://AbCdEfGhIjKlMnOpQrStUvWxYz1234@host.example/o/r.git',
  ];
  for (const url of bad) assert.throws(() => validateCloneUrl(url), /Remove the token from the URL/, url);
});

test('ordinary usernames and transports stay accepted', () => {
  for (const url of ['https://alice@bitbucket.org/team/repo.git', 'ssh://git@host.example/o/r.git', 'git@github.com:o/r.git', 'https://github.com/o/r.git', 'ssh://deploy-user@host.example:2222/o/r']) {
    assert.equal(validateCloneUrl(url), url);
  }
  assert.throws(() => validateCloneUrl('https://user:secret@github.com/o/r'), /Remove the password/);
});

test('plugin sources refuse userinfo and redaction masks token usernames', () => {
  assert.throws(() => normalizeGitUrl(`https://${TOKEN}@github.com/o/r.git`));
  const text = redactGitText(`fatal: unable to access 'https://${TOKEN}@github.com/o/r.git/'`);
  assert.ok(!text.includes(TOKEN), text);
});
