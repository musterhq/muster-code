/** One Git colour system: status/ref/PR/review/check tones, their tokens in both themes, the commit graph lanes,
 *  and restoring older Changes / History / Pull request tabs into the one Git tab. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkTone, checksTone, commitGraph, gitFileStatus, gitRefKind, gitSyncTone, porcelainStatus, prTone, reviewTone} from '../src/renderer/gitStatus.ts';
import {readWorkspace} from '../src/renderer/workspacePersistence.ts';

test('file statuses: every spelling maps to one letter and tone', () => {
  const cases: [string, string, string][] = [
    ['modified', 'M', 'modified'], ['M', 'M', 'modified'], ['changed', 'M', 'modified'], ['T', 'M', 'modified'],
    ['added', 'A', 'added'], ['A', 'A', 'added'], ['copied', 'A', 'added'], ['C075', 'A', 'added'],
    ['untracked', 'U', 'untracked'], ['??', 'U', 'untracked'],
    ['deleted', 'D', 'deleted'], ['removed', 'D', 'deleted'], ['D', 'D', 'deleted'],
    ['renamed', 'R', 'renamed'], ['R100', 'R', 'renamed'],
    ['conflicted', 'C', 'conflict'], ['unmerged', 'C', 'conflict'], ['UU', 'C', 'conflict'],
    ['ignored', 'I', 'ignored'], ['!!', 'I', 'ignored'],
  ];
  for (const [raw, code, tone] of cases) assert.deepEqual([gitFileStatus(raw).code, gitFileStatus(raw).tone], [code, tone], raw);
  assert.equal(porcelainStatus({index: 'M', worktree: 'D', untracked: false, conflict: false}, 'staged').tone, 'modified');
  assert.equal(porcelainStatus({index: 'M', worktree: 'D', untracked: false, conflict: false}, 'unstaged').tone, 'deleted');
  assert.equal(porcelainStatus({index: '?', worktree: '?', untracked: true, conflict: false}, 'unstaged').code, 'U');
  assert.equal(porcelainStatus({index: 'U', worktree: 'U', untracked: false, conflict: true}, 'unstaged').tone, 'conflict');
});

test('refs, sync, PR, review and check tones', () => {
  const local = new Set(['main', 'feat/wt']);
  assert.equal(gitRefKind('tag: v1').kind, 'tag');
  assert.equal(gitRefKind('tag: v1').label, 'v1');
  assert.equal(gitRefKind('HEAD').kind, 'head');
  assert.equal(gitRefKind('main', {current: 'main', local}).kind, 'current');
  assert.equal(gitRefKind('feat/wt', {current: 'main', local}).kind, 'local', 'a slash in a local branch name is still local');
  assert.equal(gitRefKind('origin/main').kind, 'remote');
  assert.equal(gitRefKind('fork2/topic', {local}).kind, 'remote', 'with the local list known, any other slash ref is remote');
  assert.deepEqual([gitSyncTone(0, 0), gitSyncTone(2, 0), gitSyncTone(0, 3), gitSyncTone(1, 1)], ['synced', 'ahead', 'behind', 'diverged']);
  assert.deepEqual([prTone('OPEN'), prTone('open', true), prTone('MERGED'), prTone('closed')], ['open', 'draft', 'merged', 'closed']);
  assert.deepEqual([reviewTone('APPROVED'), reviewTone('CHANGES_REQUESTED'), reviewTone('COMMENTED')], ['approved', 'changes', 'commented']);
  assert.deepEqual([checkTone({status: 'completed', conclusion: 'success'}), checkTone({status: 'completed', conclusion: 'failure'}), checkTone({status: 'in_progress'}), checkTone({status: 'completed', conclusion: 'skipped'})], ['success', 'failure', 'pending', 'skipped']);
  assert.equal(checksTone({passed: 3, failed: 1, pending: 2}), 'failure', 'any failure wins');
  assert.equal(checksTone({passed: 3, failed: 0, pending: 2}), 'pending');
  assert.equal(checksTone({passed: 3, failed: 0, pending: 0}), 'success');
});

test('every Git colour is a token with a dark and a light value', () => {
  const css = readFileSync(new URL('../src/renderer/components/git-colors.css', import.meta.url), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  const dark = block(':root'), light = block(":root[data-theme='light']");
  const names = (text: string) => new Set([...text.matchAll(/(--[a-z0-9-]+):/g)].map(match => match[1]));
  const required = ['--git-modified', '--git-added', '--git-untracked', '--git-deleted', '--git-renamed', '--git-conflict', '--git-ignored',
    '--git-add', '--git-del', '--git-staged', '--git-unstaged', '--git-ref-head', '--git-ref-current', '--git-ref-local', '--git-ref-remote', '--git-ref-tag',
    '--git-ahead', '--git-behind', '--git-diverged', '--pr-open', '--pr-draft', '--pr-merged', '--pr-closed',
    '--review-approved', '--review-changes', '--review-commented', '--ci-success', '--ci-failure', '--ci-pending', '--ci-skipped',
    ...Array.from({length: 6}, (_, index) => `--git-lane-${index}`)];
  for (const name of required) {
    assert.ok(names(dark).has(name), `${name} has a dark value`);
    assert.ok(names(light).has(name), `${name} has a light value`);
  }
  // Outside the two token blocks, rules only reference tokens: no raw hex colours.
  const rules = css.slice(css.indexOf('}', css.indexOf(":root[data-theme='light'] {")) + 1);
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i, 'component rules use tokens, not literal colours');
  // The file tree badges use the same tokens.
  const tree = readFileSync(new URL('../src/renderer/components/file-actions.css', import.meta.url), 'utf8');
  for (const tone of ['modified', 'added', 'untracked', 'deleted', 'renamed', 'conflict']) assert.match(tree, new RegExp(`\\.tree-git-${tone}\\{--git-tone:var\\(--git-${tone}\\)\\}`), `tree badge ${tone} uses its token`);
});

test('commit graph: lanes for a branch and its merge', () => {
  // m merges b into the line a; b branched from c.
  //  m (a, b)   lane 0, merge → opens lane 1 for b
  //  a (c)      lane 0
  //  b (c)      lane 1
  //  c          lane 0; lane 1 converges into it
  const rows = commitGraph([
    {sha: 'm', parents: ['a', 'b']},
    {sha: 'a', parents: ['c']},
    {sha: 'b', parents: ['c']},
    {sha: 'c', parents: []},
  ]);
  assert.deepEqual(rows.map(row => row.lane), [0, 0, 1, 0]);
  assert.equal(rows[0].merge, true);
  assert.equal(rows[1].merge, false);
  assert.ok(rows[0].segments.some(segment => segment.x1 === 0 && segment.x2 === 1 && segment.y2 === 2), 'the merge bends out to the second lane');
  assert.ok(rows[3].segments.some(segment => segment.x1 === 1 && segment.x2 === 0 && segment.y1 === 0), 'the branch bends back into its base');
  assert.notEqual(rows[0].color, rows[2].color, 'the side branch gets its own colour');
  assert.equal(Math.max(...rows.map(row => row.width)), 2);
  // A linear history stays in one lane.
  assert.deepEqual(commitGraph([{sha: '3', parents: ['2']}, {sha: '2', parents: ['1']}, {sha: '1', parents: []}]).map(row => row.width), [1, 1, 1]);
});

test('older Changes / History / Pull request tabs restore into the one Git tab per folder', () => {
  const raw = JSON.stringify({version: 2, scope: 'personal', activeTabId: 'history:f1', tabs: [
    {id: 'changes:f1', kind: 'changes', folderId: 'f1', title: 'Changes · Repo'},
    {id: 'pr:f1:7', kind: 'pullRequest', folderId: 'f1', prNumber: 7, title: '#7 Add widget', pinned: true},
    {id: 'history:f1', kind: 'history', folderId: 'f1', title: 'History · Repo'},
    {id: 'pr:f2:new', kind: 'pullRequest', folderId: 'f2', title: 'New pull request'},
    {id: 'git:f3', kind: 'git', folderId: 'f3', gitView: 'history', sha: 'abc1234', title: 'Git · Other'},
    {id: 'x', kind: 'pullRequest', title: 'no folder'},
    {id: 'file:f1:a.ts', kind: 'file', folderId: 'f1', path: 'a.ts', title: 'a.ts'},
  ]});
  const saved = readWorkspace({getItem: () => raw});
  assert.deepEqual(saved.tabs, [
    {id: 'git:f1', kind: 'git', folderId: 'f1', title: 'Git · Repo', gitView: 'history', prNumber: 7, pinned: true},
    {id: 'git:f2', kind: 'git', folderId: 'f2', title: 'Git · Repository', gitView: 'pullRequest'},
    {id: 'git:f3', kind: 'git', folderId: 'f3', title: 'Git · Other', gitView: 'history', sha: 'abc1234'},
    {id: 'file:f1:a.ts', kind: 'file', folderId: 'f1', path: 'a.ts', title: 'a.ts'},
  ]);
  assert.equal(saved.activeTabId, 'git:f1', 'the active legacy tab maps to its Git tab (and its segment)');
});
