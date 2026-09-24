const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const Module=require('node:module');
const path=require('node:path');
const code=buildSync({entryPoints:[path.resolve(__dirname,'../src/renderer/workspacePersistence.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const mod=new Module(__filename);mod._compile(code,__filename);
const {readWorkspace,saveWorkspace,MAX_TABS}=mod.exports;
function storage(){let value=null;return {getItem:()=>value,setItem:(_,v)=>{value=v;}};}
test('resource identity and active selection survive restart without caching file contents',()=>{
 const s=storage(); const tab={id:'diff:folder:src/a.ts',kind:'diff',folderId:'folder',path:'src/a.ts',title:'Diff: a.ts'};
 assert.equal(saveWorkspace(s,{tabs:[tab],activeTabId:tab.id}),true);
 assert.deepEqual(readWorkspace(s),{tabs:[tab],activeTabId:tab.id});
 assert.doesNotMatch(s.getItem(),/before|after|fileBodies/);
});
test('malformed or oversized storage recovers; duplicate identities and unbounded tabs are rejected',()=>{
 assert.deepEqual(readWorkspace({getItem:()=>'{broken'}),{tabs:[],activeTabId:null});
 assert.deepEqual(readWorkspace({getItem:()=>{throw Error('unavailable');}}),{tabs:[],activeTabId:null});
 const tabs=Array.from({length:100},(_,i)=>({id:'untrusted-id',kind:'file',folderId:'a',path:`${i}.ts`,title:'file'}));
 const value=readWorkspace({getItem:()=>JSON.stringify({version:1,tabs,activeTabId:'missing'})});
 assert.equal(value.tabs.length,MAX_TABS); assert.equal(value.activeTabId,'file:a:0.ts');
 assert.equal(saveWorkspace({setItem(){throw Error('full');}},value),false);
});
