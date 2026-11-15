import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {SourceControlScreen} from '../src/screens/SourceControlScreen';
import type {MobileGitStatus} from '../src/shared';
import {fakeConnection} from './fake-connection';

const status: MobileGitStatus = {branch: 'feat/session-streams', detached: false, upstream: 'origin/feat/session-streams', ahead: 2, behind: 0, conflicted: false, truncated: false, revision: 'rev-7',
  files: [{path: 'src/session/store.ts', change: 'modified', staged: false}, {path: 'src/session/stream-key.ts', change: 'added', staged: false}, {path: 'migrations/0042.sql', change: 'added', staged: false}],
  message: {subject: 'Move session store to Redis Streams', body: 'Appends use XADD and reads use XRANGE.'}};

// Spec: MUS-SPEC-23-25J (docs/spec/clauses/23-mobile.md#mus-spec-23-25j)
test('source control chooses files, edits the agent’s message and commits and pushes, and hides commit when read only', async () => {
  const connection = fakeConnection({'git.status': status, 'git.commit': {status: {...status, ahead: 0, files: []}, pushed: true}});
  const view = await render(<SourceControlScreen connection={connection} chatId="c1" onSwitchBranch={() => undefined} onOpenPullRequest={() => undefined} />);
  expect(await screen.findByText('feat/session-streams')).toBeTruthy();
  expect(screen.getByText('2 ahead')).toBeTruthy();
  expect(screen.getByText('To commit · 3 of 3')).toBeTruthy();
  expect(screen.getByText('Written by the agent')).toBeTruthy();
  await fireEvent.press(screen.getByRole('checkbox', {name: 'migrations/0042.sql'}));
  expect(screen.getByText('To commit · 2 of 3')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Commit message'), 'Move the session store to streams\n\nAppends use XADD.');
  await fireEvent.press(screen.getByRole('button', {name: 'Commit and push'}));
  await act(async () => undefined);
  expect(connection.calls.filter(call => call.method === 'git.commit').map(call => call.params)).toEqual([{chatId: 'c1', revision: 'rev-7',
    paths: ['src/session/store.ts', 'src/session/stream-key.ts'], message: 'Move the session store to streams\n\nAppends use XADD.', push: true}]);
  expect(await screen.findByText('Up to date')).toBeTruthy();
  await view.unmount();

  const reader = fakeConnection({'git.status': status}, 'read-only');
  await render(<SourceControlScreen connection={reader} chatId="c1" onSwitchBranch={() => undefined} onOpenPullRequest={() => undefined} />);
  expect(await screen.findByText('src/session/store.ts')).toBeTruthy();
  expect(screen.getByText('Move session store to Redis Streams', {exact: false})).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Commit'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Commit and push'})).toBeNull();
});
