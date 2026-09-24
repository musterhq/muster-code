import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cleanIpcError, gitErrorMessage, isNotGitRepository} from '../src/renderer/components/resourceErrors.ts';

test('cleanIpcError strips Electron\'s IPC boilerplate down to the underlying message', () => {
  assert.equal(
    cleanIpcError(new Error("Error invoking remote method 'muster:invoke': Error: Not a git repository: /repo")),
    'Not a git repository: /repo',
  );
  assert.equal(cleanIpcError(new Error('Plain failure')), 'Plain failure');
  assert.equal(cleanIpcError(new Error("BridgeError: Error invoking remote method 'muster:invoke': TypeError: boom")), 'boom');
  assert.doesNotMatch(cleanIpcError(new Error("Error invoking remote method 'muster:invoke': Error: Not a git repository: /repo")), /Error invoking remote method/);
});

test('isNotGitRepository matches the not-a-repo message however it is wrapped', () => {
  assert.equal(isNotGitRepository(new Error('git.changes: Error invoking remote method \'muster:invoke\': Error: Not a git repository: /repo')), true);
  assert.equal(isNotGitRepository(new Error('fatal: not a git repository (or any of the parent directories): .git')), true);
  assert.equal(isNotGitRepository(new Error('Network is unreachable')), false);
  assert.equal(isNotGitRepository(undefined), false);
});

test('gitErrorMessage is undefined for a non-repo folder (the caller shows a neutral state instead) and clean otherwise', () => {
  assert.equal(gitErrorMessage(new Error("git.changes: Error invoking remote method 'muster:invoke': Error: Not a git repository: /repo")), undefined);
  const message = gitErrorMessage(new Error("git.changes: Error invoking remote method 'muster:invoke': Error: Git timed out."));
  assert.ok(message);
  assert.doesNotMatch(message!, /Error invoking remote method/);
});

test('cleanIpcError peels only real command-name prefixes, never a leading file name', async () => {
  assert.equal(cleanIpcError(new Error("git.changes: Error invoking remote method 'muster:invoke': Error: Git timed out.")), 'Git timed out.');
  assert.equal(cleanIpcError(new Error('memory.import.apply: Archive is corrupt')), 'Archive is corrupt');
  assert.equal(cleanIpcError(new Error('package.json: Unexpected token } in JSON at position 12')), 'package.json: Unexpected token } in JSON at position 12');
  assert.equal(cleanIpcError(new Error("files.read: Error: tsconfig.json: not found")), 'tsconfig.json: not found');
  // Every runtime command's namespace is known, so none of their prefixes leak into the UI.
  const {isCommandName} = await import('../src/main/commands.ts');
  const {COMMAND_NAMESPACES} = await import('../src/renderer/components/resourceErrors.ts');
  const source = (await import('node:fs')).readFileSync(new URL('../src/main/commands.ts', import.meta.url), 'utf8');
  const {DOMAIN_COMMANDS} = await import('../src/shared/domains/index.ts');
  const {PROCESS_COMMANDS} = await import('../src/shared/process-protocol.ts');
  const {BROWSER_COMMANDS} = await import('../src/shared/browser-protocol.ts');
  const {SCOPED_COMPUTER_COMMANDS} = await import('../src/shared/scoped-computer-protocol.ts');
  const names = [...Object.keys({...DOMAIN_COMMANDS, ...PROCESS_COMMANDS, ...BROWSER_COMMANDS, ...SCOPED_COMPUTER_COMMANDS}), ...[...source.matchAll(/^\s*'([a-zA-Z]+\.[\w.]+)': true/gm)].map(match => match[1]!)];
  assert.ok(names.length > 50 && names.every(name => isCommandName(name)));
  const missing = [...new Set(names.map(name => name.split('.')[0]!))].filter(namespace => !COMMAND_NAMESPACES.has(namespace));
  assert.deepEqual(missing, []);
});
