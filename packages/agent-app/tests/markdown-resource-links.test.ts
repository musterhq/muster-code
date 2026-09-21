import {test} from 'node:test';
import assert from 'node:assert/strict';
import {markdownFragmentId, markdownHeadingId} from '../src/renderer/components/markdownAnchors.ts';
import {resourceReference} from '../src/renderer/components/resourceReference.ts';
import {filePresentation, friendlyFileError} from '../src/renderer/components/filePresentation.ts';

const folders=[{id:'workspace',name:'Workspace',path:'/tmp/workspace'}];

test('Markdown headings and fragments share a stable, scoped identifier',()=>{
  assert.equal(markdownHeadingId('Release notes: Caf\u00e9 & API'), 'muster-heading-release-notes-cafe-api');
  assert.equal(markdownFragmentId('#Release%20notes%3A%20Caf%C3%A9%20%26%20API'), 'muster-heading-release-notes-cafe-api');
  assert.equal(markdownFragmentId('#'), null);
  assert.equal(markdownFragmentId('#%E0%A4%A'), null);
});

test('workspace Markdown references accept section fragments and retain line links',()=>{
  assert.deepEqual(resourceReference('./guide.md#overview',folders,'workspace','docs/readme.md'),{
    folderId:'workspace',path:'docs/guide.md',absolute:'/tmp/workspace/docs/guide.md',
  });
  assert.deepEqual(resourceReference('./guide.md#L12-L15',folders,'workspace','docs/readme.md'),{
    folderId:'workspace',path:'docs/guide.md',absolute:'/tmp/workspace/docs/guide.md',line:12,
  });
  assert.equal(resourceReference('../outside.md#overview',folders,'workspace','readme.md'),null);
});

test('MDX files use the bounded Markdown preview path',()=>{
  assert.equal(filePresentation('docs/guide.MDX'),'markdown');
});

test('stale or denied resources produce actionable viewer copy without leaking host paths',()=>{
  assert.equal(friendlyFileError("BridgeError: ENOENT: no such file or directory, realpath '/private/tmp/fixture'"), 'This workspace folder is no longer available. Reopen the folder, then retry this resource.');
  assert.equal(friendlyFileError('Error: EACCES: permission denied'), 'Muster could not read this resource with the current access. Reopen it with an allowed workspace.');
  assert.equal(friendlyFileError('BridgeError: malformed workbook'), 'malformed workbook');
});
