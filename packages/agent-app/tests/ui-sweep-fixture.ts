export const savedSummaries:string[]=[];
const at='2026-10-01T12:00:00Z';
export const folders=[{id:'f1',name:'redis-automation',path:'/work/alpha/redis-automation'},{id:'f2',name:'redis-automation',path:'/work/beta/redis-automation'}];
const project={id:'p1',name:'Empty project',goal:'A project with no work yet',folderIds:['f1']};
export const snapshot={version:1,folders,projects:[project],chats:folders.map((f,i)=>({id:`c${i}`,title:'ossmgr UI',folderId:f.id,status:'completed',updatedAt:at,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent'})),activeChatId:'c0'};
export const workspace={paperclip:null,projects:[{...project,source:'local',description:'',status:'in_progress',taskCount:0,openCount:0,paused:false}],tasks:[],agents:[],goals:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:at};
export function installSweepFixture(){
 window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
 if(command==='extensions.sources.list')return [{id:'local',kind:'local',label:'Codex: local-marketplace',addedAt:''}];
 if(command==='extensions.catalog')return [{id:'local:notes',sourceId:'local',sourceLabel:'Codex: local-marketplace',name:'notes',kind:'plugin',displayName:'Notes',description:'Keep project notes',version:'1.0.0',capabilities:{skills:[],mcpServers:[],apps:[],hooks:[],commands:[],agents:[]},compatibility:{format:'codex',supported:true,unsupported:[],notes:[]}}];
 if(command==='extensions.installed'||command==='extensions.enablement.list')return [];
 if(command==='extensions.inventory')return {skills:[],plugins:[]};
 if(command==='app.snapshot')return snapshot;
 if(command==='settings.get')return {values:{}};
 if(command==='paperclip.snapshot')return workspace;
 if(command==='paperclip.watch')return {live:'events'};
 if(command==='project.list')return [{...project,primaryFolderId:'f1',archived:false,archivedAt:null}];
 if(command==='memory.config.get')return {endpoint:'',hasApiKey:false,keyStorage:'none',autoRecall:true,autoRetain:'ask',source:'app'};
 if(command==='memory.browse')return {records:[],status:{connection:'not-configured'}};
 if(command==='memory.deletes.list')return {deletes:[]};
 if(command==='memory.offers')return {offers:Array.from({length:20},(_,i)=>({itemId:`offer${i}`,chatId:`c${i}`,runId:`r${i}`,chatTitle:'ossmgr UI',summary:'Prefer small pull requests.\n\nFull transcript: '+('A lengthy conversation about the work. '.repeat(30)),createdAt:at}))};
 if(command==='memory.retainFromRun'){savedSummaries.push(input.summary);return {hindsight:'skipped'};}
 if(command==='memory.offer.dismiss')return {};
 if(command==='providers.list')return [{id:'router',name:'Local router',codex:{modelProvider:'router',kind:'gateway'},available:true,status:'ready',source:'Local provider profile',identityMasked:'',endpoint:'http://127.0.0.1:20128',models:[{id:'m1',name:'Model one'},{id:'m2',name:'Model two'}],excludedModels:[{id:'non-chat-models',name:'1 image, audio and other models',reason:'These models cannot run a chat.'}]}];
 if(command==='providers.accounts.list')return {accounts:[]};
 if(command==='providers.cliStatus')return [];
 if(command==='paperclip.ledger')return {entries:[],chain:{ok:true,entries:1,head:'abcdef1234567890',brokenAt:null}};
 if(command==='chat.timeline')return {items:[],revision:0};
 if(command==='git.info')return null;
 if(command==='search.chats')return [];
 return undefined;
 }} as any;
}
