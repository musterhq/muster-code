import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,mkdir,readFile,readdir,rm,utimes,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {SETTING_DEFAULTS,normalizeSettings,parseSettingsImport,redactDiagnostics,settingsExport,validateSetting} from '../src/shared/domains/settings-protocol.ts';
import {createSettingsDomain,storageCategoryOf,type ElectronApi} from '../src/runtime/domains/settings.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {filterSections,formatBytes} from '../src/renderer/components/settings/sections.ts';
import {MENU_SHORTCUTS,acceleratorKeys} from '../src/renderer/components/settings/shortcuts.ts';
import {enterTypesNewline} from '../src/renderer/components/settings/preferences.ts';

async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-settings-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

function fakeElectron(dialog:{save?:string|null;open?:string|null}={}){
  const zooms:number[]=[];const shown:string[]=[];let created:((event:unknown,win:any)=>void)|undefined;
  const win={isDestroyed:()=>false,webContents:{setZoomFactor:(factor:number)=>zooms.push(factor),on(){}}};
  const api:ElectronApi={
    app:{getName:()=>'Muster Agent',getVersion:()=>'9.9.9',getPath:()=>'/docs',getAppMetrics:()=>[{pid:11,type:'Browser',cpu:{percentCPUUsage:1.5},memory:{workingSetSize:2048}},{pid:12,type:'Utility',serviceName:'network',cpu:{percentCPUUsage:0},memory:{workingSetSize:1024}}],on:(_event,fn)=>{created=fn;},off:()=>{created=undefined;}},
    BrowserWindow:{getAllWindows:()=>[win],getFocusedWindow:()=>null},
    dialog:{showSaveDialog:async()=>dialog.save?{canceled:false,filePath:dialog.save}:{canceled:true},showOpenDialog:async()=>dialog.open?{canceled:false,filePaths:[dialog.open]}:{canceled:true,filePaths:[]}},
    shell:{showItemInFolder:path=>shown.push(path)},
  };
  return {api,zooms,shown,created:()=>created};
}

function context(dataDir:string,options:{chats?:string[];attachments?:Record<string,string[]>}={}){
  const events:any[]=[];
  const ctx={
    dataDir,
    emit:(event:unknown)=>events.push(event),
    store:{chat:(id:string)=>options.chats?.includes(id)?{id}:undefined},
    db:()=>({prepare:()=>({all:(chatId:string)=>(options.attachments?.[chatId]??[]).map(path=>({path}))})}),
  } as unknown as DomainContext;
  return {ctx,events};
}
const call=async(domain:ReturnType<typeof createSettingsDomain>,command:string,input:Record<string,unknown>={}):Promise<any>=>domain.handlers[command]!(input);

test('only whitelisted keys with valid values are accepted or kept',()=>{
  assert.equal(validateSetting('appearance.textSize',110),110);
  assert.throws(()=>validateSetting('appearance.textSize',115),/one of 90, 100, 110, 120, 130/);
  assert.throws(()=>validateSetting('general.sendKey','space'),/general\.sendKey must be/);
  assert.throws(()=>validateSetting('providers.apiKey','sk-secret'),/Unknown setting/);
  assert.throws(()=>validateSetting('__proto__',{}),/Unknown setting/);
  assert.deepEqual(normalizeSettings({'chat.inlineDiffs':false,'appearance.textSize':'big',token:'x'}),{...SETTING_DEFAULTS,'chat.inlineDiffs':false});
  assert.deepEqual(normalizeSettings(null),SETTING_DEFAULTS);
});

test('settings persist in dataDir/settings.json, emit settingsChanged and drive window zoom',async t=>{
  const dataDir=await directory(t);const electron=fakeElectron();const {ctx,events}=context(dataDir);
  const domain=createSettingsDomain(ctx,electron.api);
  assert.deepEqual((await call(domain,'settings.get')).values,SETTING_DEFAULTS);
  assert.deepEqual(electron.zooms,[1],'existing windows get the stored text size at startup');
  await call(domain,'settings.set',{key:'appearance.textSize',value:120});
  await call(domain,'settings.set',{key:'general.sendKey',value:'mod-enter'});
  await assert.rejects(call(domain,'settings.set',{key:'shell.command',value:'rm -rf /'}),/Unknown setting/);
  await assert.rejects(call(domain,'settings.set',{key:'general.spellcheck',value:'yes'}),/true or false/);
  assert.deepEqual(electron.zooms,[1,1.2]);
  assert.equal(events.at(-1).type,'settingsChanged');assert.equal(events.at(-1).values['general.sendKey'],'mod-enter');
  const stored=JSON.parse(await readFile(join(dataDir,'settings.json'),'utf8'));
  assert.deepEqual(Object.keys(stored.values).sort(),Object.keys(SETTING_DEFAULTS).sort(),'file holds only whitelisted keys');
  await domain.dispose?.();
  const reopened=createSettingsDomain(context(dataDir).ctx,undefined);
  assert.equal((await call(reopened,'settings.get')).values['appearance.textSize'],120);
  assert.deepEqual((await call(reopened,'settings.reset',{keys:['appearance.textSize']})).values,{...SETTING_DEFAULTS,'general.sendKey':'mod-enter'});
  await assert.rejects(call(reopened,'settings.reset',{keys:['nope']}),/Choose settings/);
  assert.match(await readFile(join(dataDir,'logs','runtime.log'),'utf8'),/runtime started/);
});

test('import validation reports JSON paths and never applies unknown keys',()=>{
  const good=JSON.stringify(settingsExport({...SETTING_DEFAULTS,'appearance.textSize':90}));
  assert.equal(parseSettingsImport(good).settings['appearance.textSize'],90);
  assert.throws(()=>parseSettingsImport('{nope'),/not valid JSON/);
  assert.throws(()=>parseSettingsImport('[]'),/^Error: \$: expected/);
  assert.throws(()=>parseSettingsImport(JSON.stringify({format:'other',version:1,settings:{}})),/\$\.format/);
  assert.throws(()=>parseSettingsImport(JSON.stringify({format:'muster-settings',version:2,settings:{}})),/\$\.version/);
  assert.throws(()=>parseSettingsImport(JSON.stringify({format:'muster-settings',version:1,settings:{'appearance.textSize':500}})),/\$\.settings\.appearance\.textSize must be/);
  assert.throws(()=>parseSettingsImport(JSON.stringify({format:'muster-settings',version:1,settings:{apiKey:'x'}})),/no recognised settings/);
  const mixed=parseSettingsImport(JSON.stringify({format:'muster-settings',version:1,settings:{'chat.inlineDiffs':false,apiKey:'sk-1'}}));
  assert.deepEqual(mixed,{settings:{'chat.inlineDiffs':false},ignored:['apiKey']});
  assert.throws(()=>parseSettingsImport(' '.repeat(70*1024)),/larger than 64 KB/);
});

test('export and import round-trip through the dialog with a pre-import backup',async t=>{
  const dataDir=await directory(t);const exportPath=join(dataDir,'out.json');
  const source=createSettingsDomain(context(dataDir).ctx,fakeElectron({save:exportPath}).api);
  await call(source,'settings.set',{key:'general.spellcheck',value:false});
  assert.deepEqual(await call(source,'settings.export'),{path:exportPath});
  const exported=JSON.parse(await readFile(exportPath,'utf8'));
  assert.equal(exported.format,'muster-settings');assert.equal(exported.settings['general.spellcheck'],false);

  const target=await directory(t);const electron=fakeElectron({open:exportPath});const {ctx,events}=context(target);
  const domain=createSettingsDomain(ctx,electron.api);
  await call(domain,'settings.set',{key:'appearance.textSize',value:130});
  const result=await call(domain,'settings.import');
  assert.equal(result.cancelled,false);assert.equal(result.values['general.spellcheck'],false);assert.equal(result.values['appearance.textSize'],100);
  const backup=JSON.parse(await readFile(result.backupPath,'utf8'));
  assert.equal(backup.settings['appearance.textSize'],130,'the backup holds the settings from before the import');
  assert.equal(events.at(-1).type,'settingsChanged');

  await writeFile(exportPath,JSON.stringify({format:'muster-settings',version:1,settings:{'general.sendKey':7}}));
  await assert.rejects(call(domain,'settings.import'),/\$\.settings\.general\.sendKey/);
  assert.equal((await call(domain,'settings.get')).values['general.sendKey'],'enter','a rejected import changes nothing');
  assert.equal((await readdir(join(target,'settings-backups'))).length,1,'a rejected import writes no backup');
  assert.deepEqual(await call(createSettingsDomain(context(target).ctx,fakeElectron().api),'settings.import'),{cancelled:true});
  await assert.rejects(call(createSettingsDomain(context(target).ctx,undefined),'settings.export'),/desktop app/);
});

test('diagnostics report versions, paths and per-process metrics, with a redacted copy',async t=>{
  const dataDir=await directory(t);const electron=fakeElectron();
  const report=await call(createSettingsDomain(context(dataDir).ctx,electron.api),'settings.diagnostics');
  assert.equal(report.app.version,'9.9.9');assert.equal(report.node,process.versions.node);
  assert.equal(report.logPath,join(dataDir,'logs','runtime.log'));
  assert.deepEqual(report.processes,[{pid:11,type:'Browser',memoryKB:2048,cpuPercent:1.5},{pid:12,type:'Utility',name:'network',memoryKB:1024,cpuPercent:0}]);
  assert.match(report.redactedText,/Utility \(network\) pid 12: 1\.0 MB/);
  const plain=await call(createSettingsDomain(context(dataDir).ctx,undefined),'settings.diagnostics');
  assert.deepEqual(plain.processes,[]);
});

test('redaction masks home paths, the account name and emails',()=>{
  const text='Data: /Users/dana/Library/Muster\nLog: /Users/dana/x.log\nuser dana signed in as dana.lee@example.com; danae stays';
  const out=redactDiagnostics(text,'/Users/dana','dana');
  assert.equal(out,'Data: ~/Library/Muster\nLog: ~/x.log\nuser <user> signed in as <email>; danae stays');
  assert.doesNotMatch(out,/dana\b|example\.com/);
});

test('storage groups dataDir by category and cleanup removes only confirmed, still-eligible items',async t=>{
  const dataDir=await directory(t);
  const keep=join(dataDir,'attachments','live','keep.png'),orphan=join(dataDir,'attachments','live','old.png'),fresh=join(dataDir,'attachments','live','staging.png');
  for(const dir of ['scratch/live','scratch/gone','attachments/live','attachments/gone','scoped-computers/x','memory'])await mkdir(join(dataDir,dir),{recursive:true});
  await writeFile(join(dataDir,'scratch','gone','a.txt'),'12345');await writeFile(join(dataDir,'scratch','live','b.txt'),'1');
  await writeFile(keep,'k');await writeFile(orphan,'orphan');await writeFile(fresh,'f');await writeFile(join(dataDir,'attachments','gone','x.txt'),'xx');
  const old=new Date(Date.now()-3600_000);await utimes(orphan,old,old);
  await writeFile(join(dataDir,'muster-agent.sqlite'),'db');await writeFile(join(dataDir,'muster-agent.sqlite-wal'),'wal');
  const domain=createSettingsDomain(context(dataDir,{chats:['live'],attachments:{live:[keep]}}).ctx,undefined);
  const report=await call(domain,'settings.storage');
  const by=Object.fromEntries(report.categories.map((row:any)=>[row.id,row]));
  assert.equal(by.sqlite.bytes,5);assert.equal(by.scratch.bytes,6);assert.equal(by.scratch.cleanable,true);assert.equal(by.sqlite.cleanable,false);
  assert.ok(by.logs,'the runtime log counts under Logs');
  assert.equal(storageCategoryOf('workspace-memory'),'memory');assert.equal(storageCategoryOf('provider-connections.sqlite-shm'),'sqlite');

  const scratch=await call(domain,'settings.storage.preview',{category:'scratch'});
  assert.deepEqual(scratch.items.map((item:any)=>item.name),['gone'],'a live chat’s scratch folder is never offered');
  const attachments=await call(domain,'settings.storage.preview',{category:'attachments'});
  assert.deepEqual(attachments.items.map((item:any)=>item.name).sort(),['gone','live/old.png'],'referenced and just-written files are kept');
  await assert.rejects(call(domain,'settings.storage.preview',{category:'memory'}),/Only attachments and scratch/);
  await assert.rejects(call(domain,'settings.storage.cleanup',{category:'scratch',names:['gone']}),/Confirm/);

  const removed=await call(domain,'settings.storage.cleanup',{category:'attachments',names:['live/old.png','live/keep.png','../scratch/live','gone'],confirm:true});
  assert.deepEqual(removed,{removed:2,bytes:8});
  assert.ok(existsSync(keep)&&existsSync(fresh)&&existsSync(join(dataDir,'scratch','live')));
  assert.ok(!existsSync(orphan)&&!existsSync(join(dataDir,'attachments','gone')));
  assert.match(await readFile(join(dataDir,'logs','runtime.log'),'utf8'),/storage cleanup · attachments · removed 2/);
});

test('attachment cleanup offers nothing when the attachment index cannot be read',async t=>{
  const dataDir=await directory(t);await mkdir(join(dataDir,'attachments','live'),{recursive:true});
  const file=join(dataDir,'attachments','live','a.png');await writeFile(file,'a');const old=new Date(Date.now()-3600_000);await utimes(file,old,old);
  const {ctx}=context(dataDir,{chats:['live']});(ctx as any).db=()=>{throw new Error('locked');};
  assert.deepEqual((await call(createSettingsDomain(ctx,undefined),'settings.storage.preview',{category:'attachments'})).items,[]);
});

test('settings search matches labels and keywords; shortcuts mirror the app menu',async()=>{
  assert.deepEqual(filterSections('').length,12);
  // PRO-07: Models, Environments and Automations are sections of the one searchable shell.
  assert.deepEqual(filterSections('sandbox container').map(section=>section.id),['environments']);
  assert.deepEqual(filterSections('cron').map(section=>section.id),['automations']);
  assert.deepEqual(filterSections('tool search').map(section=>section.id),['models']);
  assert.deepEqual(filterSections('mute notifications').map(section=>section.id),['general']);
  assert.deepEqual(filterSections('zoom').map(section=>section.id),['appearance']);
  assert.deepEqual(filterSections('API KEY').map(section=>section.id),['providers']);
  assert.deepEqual(filterSections('log cpu').map(section=>section.id),['diagnostics']);
  assert.deepEqual(filterSections('summary card').map(section=>section.id),['appearance']);
  assert.deepEqual(filterSections('ignore whitespace').map(section=>section.id),['chat']);
  assert.deepEqual(filterSections('nothing-like-this'),[]);
  const menu=await readFile(resolve(import.meta.dirname,'../src/main/menu.ts'),'utf8');
  for(const shortcut of MENU_SHORTCUTS)assert.ok(menu.includes(`'${shortcut.accelerator}'`)||(shortcut.accelerator==='CmdOrCtrl+1'&&menu.includes('`CmdOrCtrl+${slot}`')),`${shortcut.label} ${shortcut.accelerator} is registered in menu.ts`);
  assert.deepEqual(acceleratorKeys('Shift+CmdOrCtrl+A',true),['⇧','⌘','A']);
  assert.deepEqual(acceleratorKeys('Alt+CmdOrCtrl+B',false),['Alt','Ctrl','B']);
  assert.deepEqual(acceleratorKeys('CmdOrCtrl+1',true),['⌘','1…9']);
  assert.equal(formatBytes(512),'512 B');assert.equal(formatBytes(1536),'1.5 KB');assert.equal(formatBytes(300*1024*1024),'300 MB');
});

test('⌘Enter mode turns only a bare Enter in the message field into a new line',()=>{
  const field={matches:(selector:string)=>selector==='textarea.composer-input',getAttribute:()=>null};
  const enter={key:'Enter',metaKey:false,ctrlKey:false,altKey:false,shiftKey:false};
  assert.equal(enterTypesNewline('mod-enter',enter,field),true);
  assert.equal(enterTypesNewline('enter',enter,field),false);
  assert.equal(enterTypesNewline('mod-enter',{...enter,metaKey:true},field),false,'⌘Enter still reaches the composer to send');
  assert.equal(enterTypesNewline('mod-enter',{...enter,isComposing:true},field),false);
  assert.equal(enterTypesNewline('mod-enter',enter,{...field,getAttribute:()=> 'true'}),false,'an open suggestion list keeps Enter to pick');
  assert.equal(enterTypesNewline('mod-enter',enter,{matches:()=>false}),false);
});

test('chat defaults resolve Project → user → built-in and skip a level whose provider or model is gone',async t=>{
  const {resolveChatDefaults}=await import('../src/shared/domains/settings-protocol.ts');
  const builtin={providerId:'hybrow',model:'claude/claude-fable-5'};
  const providers:any[]=[
    {id:'hybrow',name:'Hybrow',available:true,identityMasked:'',models:[{id:'claude/claude-fable-5',name:'Fable',efforts:['low','medium','high'],defaultEffort:'medium'}]},
    {id:'codex',name:'Codex',available:true,identityMasked:'',models:[{id:'gpt-6',name:'GPT-6',efforts:['low','high','xhigh'],defaultEffort:'high'}]},
    {id:'ollama',name:'Ollama',available:false,identityMasked:'',models:[{id:'llama',name:'Llama'}]},
  ];
  const project={providerId:'codex',model:'gpt-6',effort:'xhigh' as const},user={providerId:'hybrow',model:'claude/claude-fable-5',effort:'low' as const};
  assert.deepEqual(resolveChatDefaults({project,user,providers,builtin}),{providerId:'codex',model:'gpt-6',effort:'xhigh',source:'project'});
  assert.deepEqual(resolveChatDefaults({user,providers,builtin}),{providerId:'hybrow',model:'claude/claude-fable-5',effort:'low',source:'user'});
  assert.deepEqual(resolveChatDefaults({providers,builtin}),{...builtin,effort:'medium',source:'runtime'});
  // Provider gone, provider not ready, model delisted: each falls through silently to the next level.
  assert.equal(resolveChatDefaults({project,user,providers:providers.filter(p=>p.id!=='codex'),builtin}).source,'user');
  assert.equal(resolveChatDefaults({project:{providerId:'ollama',model:'llama'},user,providers,builtin}).source,'user');
  assert.deepEqual(resolveChatDefaults({user:{providerId:'codex',model:'gpt-5'},providers,builtin}),{...builtin,effort:'medium',source:'runtime'});
  // An effort the model does not offer falls back to the model's own default.
  assert.deepEqual(resolveChatDefaults({user:{providerId:'codex',model:'gpt-6',effort:'medium'},providers,builtin}),{providerId:'codex',model:'gpt-6',effort:'high',source:'user'});
  assert.throws(()=>validateSetting('general.defaultModel',{providerId:'x',model:''}),/providerId, model/);
  assert.throws(()=>validateSetting('general.defaultModel',{providerId:'codex',model:'gpt-6',effort:'max'}),/providerId, model/);
  assert.deepEqual(validateSetting('general.defaultModel',project),project);
  assert.equal(validateSetting('general.defaultModel',null),null);

  const dataDir=await directory(t);const {ctx,events}=context(dataDir);
  let resolver:((input:{folderId?:string;projectId?:string})=>unknown)|undefined;
  let catalog=providers;
  Object.assign(ctx,{hooks:{setChatDefaults:(fn:typeof resolver)=>{resolver=fn;}},modelCatalog:()=>({providers:catalog,builtin}),store:{chat:()=>undefined,project:(id:string)=>id==='p1'?{id}:undefined}});
  const domain=createSettingsDomain(ctx,undefined);
  assert.deepEqual(await call(domain,'chat.defaults',{}),{...builtin,effort:'medium',source:'runtime'});
  assert.equal(resolver!({}),undefined,'the built-in level adds nothing: chat.create keeps its own fallback');
  await call(domain,'settings.set',{key:'general.defaultModel',value:user});
  assert.ok(events.some(event=>event.type==='chatDefaultsChanged'));
  await assert.rejects(call(domain,'settings.projectModel.set',{projectId:'missing',value:project}),/Project not found/);
  assert.deepEqual((await call(domain,'settings.projectModel.set',{projectId:'p1',value:project})).value,project);
  assert.deepEqual(events.at(-1),{type:'chatDefaultsChanged',projectId:'p1'});
  assert.deepEqual(await call(domain,'chat.defaults',{projectId:'p1'}),{...project,source:'project'});
  assert.deepEqual(await call(domain,'chat.defaults',{folderId:'f1'}),{...user,source:'user'});
  assert.deepEqual(resolver!({projectId:'p1'}),{providerId:'codex',model:'gpt-6',effort:'xhigh'});
  catalog=providers.filter(p=>p.id!=='codex');
  assert.equal((await call(domain,'chat.defaults',{projectId:'p1'})).source,'user','the Project default\'s provider disappeared');
  // Both persist runtime-side and survive a restart.
  const reopened=createSettingsDomain({...ctx} as DomainContext,undefined);
  catalog=providers;
  assert.deepEqual((await call(reopened,'settings.projectModel.get',{projectId:'p1'})).value,project);
  assert.deepEqual((await call(reopened,'settings.get')).values['general.defaultModel'],user);
  assert.equal((await call(reopened,'settings.projectModel.set',{projectId:'p1',value:null})).value,null);
  assert.equal((await call(reopened,'chat.defaults',{projectId:'p1'})).source,'user');
});

test('a project id that names an Object.prototype member is just a key, never a stored default',async t=>{
  const dataDir=await directory(t);const {ctx}=context(dataDir);
  const builtin={providerId:'hybrow',model:'m'};
  Object.assign(ctx,{hooks:{setChatDefaults:()=>{}},modelCatalog:()=>({providers:[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'',models:[{id:'m',name:'M'}]}],builtin}),store:{chat:()=>undefined,project:()=>({})}});
  const domain=createSettingsDomain(ctx,undefined);
  for (const projectId of ['constructor','toString','__proto__']) {
    assert.equal((await call(domain,'settings.projectModel.get',{projectId})).value,null,projectId);
    assert.equal((await call(domain,'chat.defaults',{projectId})).source,'runtime',projectId);
  }
  await call(domain,'settings.projectModel.set',{projectId:'p1',value:{providerId:'hybrow',model:'m'}});
  assert.equal((await call(domain,'settings.projectModel.get',{projectId:'constructor'})).value,null,'still null after the map was rewritten');
  assert.deepEqual((await call(domain,'settings.projectModel.set',{projectId:'__proto__',value:{providerId:'hybrow',model:'m'}})).value,{providerId:'hybrow',model:'m'});
  assert.deepEqual((await call(domain,'settings.projectModel.get',{projectId:'__proto__'})).value,{providerId:'hybrow',model:'m'});
});

test('chat defaults: a folder resolves to its Project, deleted Projects lose their default, and the first probe is awaited',async t=>{
  const dataDir=await directory(t);const {ctx}=context(dataDir);
  const builtin={providerId:'hybrow',model:'m'};
  const projects=new Map<string,{id:string;folderIds:string[]}>([['p1',{id:'p1',folderIds:['f1']}],['p2',{id:'p2',folderIds:['f2','shared']}],['p3',{id:'p3',folderIds:['shared']}]]);
  let available=false,probe:()=>void=()=>{};
  const probed=new Promise<void>(resolve=>{probe=()=>{available=true;resolve();};});
  Object.assign(ctx,{hooks:{setChatDefaults:()=>{}},
    modelCatalog:()=>({providers:[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'',models:[{id:'m',name:'M'}]},{id:'codex',name:'Codex',available,identityMasked:'',models:[{id:'gpt-6',name:'GPT-6'}]}],builtin}),
    modelCatalogReady:()=>probed,
    store:{chat:()=>undefined,project:(id:string)=>projects.get(id)}});
  const domain=createSettingsDomain(ctx,undefined);
  const codex={providerId:'codex',model:'gpt-6'};
  for (const id of ['p1','p2','p3']) await call(domain,'settings.projectModel.set',{projectId:id,value:codex});
  // Before the first probe settles Codex isn't available; chat.defaults waits for it instead of falling back.
  const pending=call(domain,'chat.defaults',{folderId:'f1'});
  setTimeout(probe,20);
  assert.deepEqual(await pending,{...codex,source:'project'},'folder f1 → Project p1 → its default, after the probe');
  assert.equal((await call(domain,'chat.defaults',{folderId:'shared'})).source,'runtime','a folder in two Projects is ambiguous');
  assert.equal((await call(domain,'chat.defaults',{folderId:'nowhere'})).source,'runtime');
  // Deleting p1 drops its stored default the next time defaults are read.
  projects.delete('p1');
  await call(domain,'chat.defaults',{});
  const stored=JSON.parse(await readFile(join(dataDir,'project-model-defaults.json'),'utf8')).projects;
  assert.deepEqual(Object.keys(stored).sort(),['p2','p3']);
});

test('CMP-23: a folder default sits between the Project and user defaults, persists, and is dropped with its folder',async t=>{
  const {resolveChatDefaults}=await import('../src/shared/domains/settings-protocol.ts');
  const builtin={providerId:'hybrow',model:'m'};
  const providers:any[]=[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'',models:[{id:'m',name:'M'},{id:'f',name:'F'},{id:'p',name:'P'}]}];
  const folderPref={providerId:'hybrow',model:'f'},projectPref={providerId:'hybrow',model:'p'},user={providerId:'hybrow',model:'m'};
  assert.equal(resolveChatDefaults({project:projectPref,folder:folderPref,user,providers,builtin}).source,'project');
  assert.deepEqual(resolveChatDefaults({folder:folderPref,user,providers,builtin}),{...folderPref,source:'folder'});
  assert.equal(resolveChatDefaults({folder:{providerId:'gone',model:'f'},user,providers,builtin}).source,'user','a folder default whose provider is gone falls through');

  const dataDir=await directory(t);const {ctx,events}=context(dataDir);
  let folders=new Set(['f1','f2']);
  Object.assign(ctx,{hooks:{setChatDefaults:()=>{}},modelCatalog:()=>({providers,builtin}),store:{chat:()=>undefined,folder:(id:string)=>folders.has(id)?{id}:undefined,project:()=>undefined}});
  const domain=createSettingsDomain(ctx,undefined);
  assert.equal((await call(domain,'settings.folderModel.get',{folderId:'f1'})).value,null);
  await assert.rejects(call(domain,'settings.folderModel.set',{folderId:'missing',value:folderPref}),/Folder not found/);
  await assert.rejects(call(domain,'settings.folderModel.set',{folderId:'f1',value:{providerId:'hybrow',model:''}}),/provider and model/);
  assert.deepEqual((await call(domain,'settings.folderModel.set',{folderId:'f1',value:folderPref})).value,folderPref);
  assert.deepEqual(events.at(-1),{type:'chatDefaultsChanged',folderId:'f1'});
  assert.deepEqual(await call(domain,'chat.defaults',{folderId:'f1'}),{...folderPref,source:'folder'});
  assert.equal((await call(domain,'chat.defaults',{folderId:'f2'})).source,'runtime','other folders are unaffected');
  const reopened=createSettingsDomain({...ctx} as DomainContext,undefined);
  assert.deepEqual((await call(reopened,'settings.folderModel.get',{folderId:'f1'})).value,folderPref,'survives a restart');
  folders=new Set(['f2']);
  assert.equal((await call(reopened,'chat.defaults',{folderId:'f1'})).source,'runtime','a removed folder loses its default');
  assert.doesNotMatch(await readFile(join(dataDir,'folder-model-defaults.json'),'utf8'),/"f1"/);
  assert.equal((await call(reopened,'settings.folderModel.set',{folderId:'f2',value:null})).value,null);
});
