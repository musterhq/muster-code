import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resourceReference} from '../src/renderer/components/resourceReference.ts';
const folders=[{id:'a',name:'app',path:'/work/app'},{id:'b',name:'other',path:'/work/other'}];
test('local links stay scoped, decode paths and preserve line targets',()=>{
 assert.deepEqual(resourceReference('src/My%20File.ts#L42',folders,'a'),{folderId:'a',path:'src/My File.ts',absolute:'/work/app/src/My File.ts',line:42});
 assert.equal(resourceReference('/work/other/a.ts:8',folders,'a')?.folderId,'b');
 assert.equal(resourceReference('a.ts:8',folders,'a')?.line,8);
 for(const path of ['../private','/work/app2/secret','/work/app/../../secret','%00a','javascript:alert(1)','https://x/a','//host/a','%ZZ'])assert.equal(resourceReference(path,folders,'a'),null,path);
 assert.equal(resourceReference('ambiguous.ts',folders),null);
});

test('document links resolve from document directory within its registered folder',()=>{
 assert.equal(resourceReference('../src/My%20File.ts#L8',folders,'a','docs/guide.md')?.path,'src/My File.ts');
 assert.equal(resourceReference('child.md',folders,'a','docs/guide.md')?.path,'docs/child.md');
 assert.equal(resourceReference('../../private',folders,'a','docs/guide.md'),null);
 assert.equal(resourceReference('/work/app/src/a.ts',folders,'a','docs/guide.md')?.path,'src/a.ts');
});
