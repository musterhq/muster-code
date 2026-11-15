import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {BranchSheet} from '../src/screens/BranchSheet';
import {PullRequestSheet} from '../src/screens/PullRequestSheet';
import {fakeConnection} from './fake-connection';

const branches = {current: 'feat/session-streams', local: [{name: 'feat/session-streams', current: true, ahead: 2}, {name: 'main'}], remote: [{name: 'origin/release/2026.11'}], uncommitted: 2, running: true};
const status = {branch: 'fix', detached: false, upstream: null, ahead: 0, behind: 0, conflicted: false, truncated: false, revision: 'r2', files: [], message: null};

// Spec: MUS-SPEC-23-25K (docs/spec/clauses/23-mobile.md#mus-spec-23-25k)
test('the branch sheet finds, creates and switches, and the pull request sheet opens a draft with reviewers', async () => {
  const connection = fakeConnection({'git.branches': branches, 'git.switch': {status, paused: true},
    'pr.draft': {available: true, head: 'feat/session-streams', base: 'main', bases: ['main'], title: 'Move session store to Redis Streams', body: '## Summary', needsPush: true},
    'pr.create': {number: 471, url: 'https://github.com/acme/atlas-api/pull/471', title: 'Move session store to Redis Streams', draft: true}});
  const done: string[] = [];
  const sheet = await render(<BranchSheet connection={connection} chatId="c1" onDone={branch => done.push(branch)} />);
  expect(await screen.findByText('2 uncommitted files move with you. The agent pauses first.')).toBeTruthy();
  expect(screen.getByRole('button', {name: 'main'})).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Find or create a branch'), 'fix');
  expect(screen.queryByRole('button', {name: 'main'})).toBeNull();
  await fireEvent.press(screen.getByRole('button', {name: 'Create “fix”'}));
  await act(async () => undefined);
  await sheet.unmount();
  await render(<BranchSheet connection={connection} chatId="c1" onDone={branch => done.push(branch)} />);
  await fireEvent.press(await screen.findByRole('button', {name: 'origin/release/2026.11'}));
  await act(async () => undefined);
  expect(connection.calls.filter(call => call.method === 'git.switch').map(call => call.params)).toEqual([
    {chatId: 'c1', branch: 'fix', create: true}, {chatId: 'c1', branch: 'origin/release/2026.11', remote: true}]);
  expect(done).toEqual(['fix', 'fix']);

  const opened: string[] = [];
  await render(<PullRequestSheet connection={connection} chatId="c1" onOpened={url => opened.push(url)} />);
  expect(await screen.findByText('feat/session-streams into main')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Description'), '## Summary\n\n- Appends use `XADD`');
  await fireEvent(screen.getByRole('switch', {name: 'Draft'}), 'valueChange', true);
  await fireEvent.changeText(screen.getByLabelText('Reviewers'), 'platform-team');
  await fireEvent.press(screen.getByRole('button', {name: 'Open pull request'}));
  await act(async () => undefined);
  expect(connection.calls.filter(call => call.method === 'pr.create').map(call => call.params)).toEqual([{chatId: 'c1', base: 'main', title: 'Move session store to Redis Streams',
    body: '## Summary\n\n- Appends use `XADD`', draft: true, reviewers: ['platform-team']}]);
  expect(opened).toEqual(['https://github.com/acme/atlas-api/pull/471']);
});
