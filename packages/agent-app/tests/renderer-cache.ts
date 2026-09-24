import assert from 'node:assert/strict';
const saved=new Map<string,string>();
const reads=new Map<string,number>();
const chats=Array.from({length:40},(_,i)=>({id:`chat-${i}`,title:`Chat ${i}`,pinned:false,archived:false,draft:'',status:'idle',updatedAt:'',model:'fixture',mode:'ask'}));
let listener:(event:any)=>void=()=>{};
Object.assign(globalThis,{localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)},window:{setTimeout,clearTimeout,addEventListener(){},removeEventListener(){},muster:{subscribe(fn:any){listener=fn;return()=>{};},async invoke(command:string,input:any){
 if(command==='app.snapshot')return{chats,folders:[],projects:[],activeChatId:'chat-0',version:1};
 if(command==='chat.timeline'){reads.set(input.id,(reads.get(input.id)??0)+1);return{revision:1,items:[{id:input.id,chatId:input.id,kind:'assistant',text:'Durable '+input.id,createdAt:''}]};}
 if(command==='chat.contextTelemetry')return{usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
 if(command==='chat.update')return{...chats.find(chat=>chat.id===input.id),...input};
 if(command==='workspace.watch')return;
 throw new Error('Unexpected '+command);
}}}});
const store=await import('../src/renderer/store');
await store.boot();await store.selectChat('chat-0');
store.openSubagentsTab('chat-0',undefined,'First');
store.setComposerDraft('chat-0','Keep this draft');
for(let i=1;i<40;i++)await store.selectChat(`chat-${i}`);
const count=Object.keys(store.getState().timelines).length;
assert.ok(count<=10,`40 visited chats retained ${count} timelines`);
assert.ok(store.getState().timelines['chat-0'],'open subagent transcript is retained');
assert.ok(!store.getState().timelines['chat-1'],'old inactive history is evicted');
listener({type:'timelinePatch',chatId:'chat-1',patch:{after:1,revision:2,items:[]}});
assert.ok(!store.getState().timelines['chat-1'],'background update must not allocate an evicted history');
await store.selectChat('chat-1');
assert.equal(reads.get('chat-1'),2,'revisit reloads the authoritative history');
assert.equal(store.getState().timelines['chat-1'].value?.[0].text,'Durable chat-1');
assert.equal(store.getState().composerDrafts['chat-0'].text,'Keep this draft');
console.log(`PASS: 40 visited chats retain ${count} histories; protected resource and draft survive; evicted chat restores from runtime`);
