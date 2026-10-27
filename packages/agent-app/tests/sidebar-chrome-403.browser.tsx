/** Isolated review page: real renderer components, fixture chats only. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {generateChatTitle} from '../src/runtime/chat-title';
import {applyThemeTokens,MUSTER_DARK,MUSTER_LIGHT} from '../src/shared/theme';
import '../src/renderer/styles.css';
const params=new URLSearchParams(location.search),dark=params.get('theme')==='dark';
document.documentElement.dataset.theme=dark?'dark':'light';applyThemeTokens(document.documentElement,dark?MUSTER_DARK:MUSTER_LIGHT);
localStorage.clear();
const mk=(id:string,extra:any={})=>({id,title:'Release notes?',folderId:'alpha',status:'completed',updatedAt:new Date(Date.now()-3600000).toISOString(),pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',...extra});
let chats=[mk('a',{title:generateChatTitle('Why deploy?')}),mk('b'),mk('c'),mk('d',{folderId:'beta'}),mk('plain',{title:'Planning',folderId:undefined})];
const listeners=new Set<(event:any)=>void>();
const snapshot=()=>({version:1,chats,folders:[{id:'alpha',name:'Alpha',path:'/Users/fixture/projects/alpha'},{id:'beta',name:'Beta',path:'/Users/fixture/projects/beta'}],projects:[],activeChatId:'a'});
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='chat.defaults')return {providerId:'fixture',model:'fixture',source:'runtime'};
  if(command==='providers.list')return [{id:'fixture',name:'Fixture',available:true,models:[{id:'fixture',name:'Fixture'}]}];
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='checkout.leases')return {leases:[]};
  if(command==='processes.list')return {sessions:[]};
  if(command==='chat.create'){const chat=mk(`new-${chats.length}`,{title:'New chat',...input});chats=[...chats,chat];for(const fn of listeners)fn({type:'snapshot',snapshot:snapshot()});return chat;}
  if(command==='chat.send')return {runId:'fixture-run',replay:false};
  if(command==='plugins.list'||command==='plugins.inventory'||command==='skills.list'||command==='files.list')return [];
  if(command==='files.search')return {entries:[],truncated:false};
  return undefined;
}};
const store=await import('../src/renderer/store'),drafts=await import('../src/renderer/newChatDraft');
const {Sidebar}=await import('../src/renderer/components/Sidebar'),{NewChatScreen}=await import('../src/renderer/components/NewChatScreen'),{Timeline}=await import('../src/renderer/components/ChatView');
await store.boot();await store.selectChat('a');
if(params.get('view')==='draft'){await store.selectChat('plain');drafts.openNewChat();}
const items:any[]=[{id:'u',chatId:'a',kind:'user',text:'Why deploy?',createdAt:'2026-10-27T10:00:00Z'},{id:'a',chatId:'a',kind:'assistant',text:'The release is ready. Review the notes and check the preview before publishing.',createdAt:'2026-10-27T10:00:01Z'}];
function Page(){const draft=drafts.useNewChatDraft();return <div className="app" style={{display:'flex',height:'100vh'}}><nav className="nav" aria-label="Chats and folders" style={{width:260}}><div className="nav-content" style={{width:244}}><div className="nav-chats"><Sidebar/></div></div></nav><main style={{display:'flex',flexDirection:'column',flex:1,minWidth:0}}>{draft.open?<NewChatScreen/>:<><header className="chat-head"><span className="chat-head-title">{chats[0].title}</span></header><Timeline chatId="a" items={items}/></>}</main></div>;}
createRoot(document.getElementById('root')!).render(<Page/>);
