import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readCollapsed,saveCollapsed,MAX_GROUPS} from '../src/renderer/sidebarDisclosure.ts';

test('collapsed identity survives reload without conflating equally named folder and project',()=>{
 let value:string|null=null;
 const storage={getItem:()=>value,setItem:(_key:string,next:string)=>{value=next;}};
 assert.equal(saveCollapsed(storage,new Set(['folder:one','project:one','pinned'])),true);
 assert.deepEqual([...readCollapsed(storage)],['folder:one','project:one','pinned']);
});
test('corrupt, inaccessible and oversized persistence degrades safely',()=>{
 for(const value of ['null','{','{"version":2,"collapsed":["pinned"]}','x'.repeat(20000)])assert.equal(readCollapsed({getItem:()=>value}).size,0);
 assert.equal(readCollapsed({getItem:()=>{throw Error('denied');}}).size,0);
 assert.equal(saveCollapsed({setItem:()=>{throw Error('quota');}},new Set(['pinned'])),false);
 const value=JSON.stringify({version:1,collapsed:[null,1,'',...Array.from({length:250},(_,i)=>`folder:${i}`)]});
 assert.equal(readCollapsed({getItem:()=>value}).size,MAX_GROUPS);
});
