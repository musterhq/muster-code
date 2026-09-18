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
