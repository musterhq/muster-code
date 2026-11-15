import {act, fireEvent, render, screen} from '@testing-library/react-native';
import {FilesScreen} from '../src/screens/FilesScreen';
import {noteOpened} from '../src/recent';
import type {MobileFileEntry, MobileGitStatus} from '../src/shared';
import {fakeConnection} from './fake-connection';

const top: MobileFileEntry[] = [{name: 'src', path: 'src', kind: 'directory', changed: 2}, {name: 'README.md', path: 'README.md', kind: 'file'}];
const src: MobileFileEntry[] = [{name: 'store.ts', path: 'src/store.ts', kind: 'file', change: 'modified'}, {name: 'stream-key.ts', path: 'src/stream-key.ts', kind: 'file', change: 'added'}, {name: 'types.ts', path: 'src/types.ts', kind: 'file'}];
const status: MobileGitStatus = {branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, conflicted: false, truncated: false, revision: 'r1', message: null,
  files: [{path: 'src/store.ts', change: 'modified', staged: false}, {path: 'src/stream-key.ts', change: 'added', staged: false}]};

// Spec: MUS-SPEC-23-25D (docs/spec/clauses/23-mobile.md#mus-spec-23-25d)
test('the files screen drills down one folder at a time and filters to changed and recent files', async () => {
  noteOpened('device-1:c1', 'src/types.ts');
  const connection = fakeConnection({'files.list': (params: {path?: string}) => ({folder: 'atlas-api', path: params.path ?? '', entries: params.path === 'src' ? src : top, truncated: false}), 'git.status': status});
  const opened: string[] = [], files: string[] = [];
  const view = await render(<FilesScreen connection={connection} chatId="c1" onOpenFolder={path => opened.push(path)} onOpenFile={path => files.push(path)} />);
  expect(await screen.findByRole('header', {name: 'atlas-api'})).toBeTruthy();
  expect(screen.getByText('2 modified')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', {name: 'src, folder'}));
  expect(opened).toEqual(['src']);
  await view.unmount();

  await render(<FilesScreen connection={connection} chatId="c1" path="src" onOpenFolder={path => opened.push(path)} onOpenFile={path => files.push(path)} />);
  expect(await screen.findByRole('header', {name: 'src'})).toBeTruthy();
  expect(screen.getByText('atlas-api › src')).toBeTruthy();
  expect(connection.calls.filter(call => call.method === 'files.list').map(call => call.params)).toContainEqual({chatId: 'c1', path: 'src'});
  expect(screen.getByLabelText('Opened recently')).toBeTruthy();
  await fireEvent.press(screen.getByRole('tab', {name: 'Changed 2'}));
  expect(screen.getByRole('button', {name: 'store.ts, Modified'})).toBeTruthy();
  expect(screen.getByRole('button', {name: 'stream-key.ts, Added'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'types.ts'})).toBeNull();
  await fireEvent.press(screen.getByRole('tab', {name: 'Recent'}));
  await act(async () => undefined);
  await fireEvent.press(screen.getByRole('button', {name: 'types.ts'}));
  expect(files).toEqual(['src/types.ts']);
});
