import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {extensionsOptions} from '../src/runtime/domains/extensions.ts';
import {PROMPT_CONTRIBUTION_MAX_BYTES} from '../src/runtime/domains/hooks.ts';
import {installPackage,normalizeGitUrl,packageFiles,readCatalog,syncGitSource} from '../src/runtime/plugin-install.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';

async function directory(t:TestContext,prefix='muster-ext-'){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function put(path:string,text:string){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,text);}
const json=(value:unknown)=>JSON.stringify(value,null,1);

/** A Claude-format marketplace with one plugin (skill + stdio MCP server + a hook) at `version`. */
async function marketplace(root:string,version='1.0.0'){
  await put(join(root,'.claude-plugin','marketplace.json'),json({name:'acme',owner:{name:'Acme'},plugins:[
    {name:'notes',source:'./plugins/notes',description:'Take notes',version},
    {name:'escape',source:'../outside'},
    {name:'remote',source:{source:'github',repo:'acme/remote'}},
  ]}));
  const dir=join(root,'plugins','notes');
  await put(join(dir,'.claude-plugin','plugin.json'),json({name:'notes',version,license:'MIT',author:{name:'Acme Inc'},outputStyles:'./styles'}));
  await put(join(dir,'skills','jot','SKILL.md'),'---\nname: jot\ndescription: Jot things\n---\n\nWrite NOTES-SKILL-BODY down.\n');
  await put(join(dir,'.mcp.json'),json({mcpServers:{store:{command:'${CLAUDE_PLUGIN_ROOT}/bin/store',args:['--db','${CLAUDE_PLUGIN_ROOT}/db']}}}));
  await put(join(dir,'hooks','hooks.json'),json({hooks:{PreToolUse:[{matcher:'*',hooks:[{type:'command',command:'echo hi'}]}]}}));
  return dir;
}

test('catalog reads a Claude marketplace, refuses escaping and remote sources, and reports compatibility',async t=>{
  const root=await directory(t);await marketplace(root);
  const catalog=await readCatalog(root,{id:'src1',label:'acme'});
  const notes=catalog.find(entry=>entry.pkg.name==='notes')!;
  assert.equal(notes.pkg.id,'src1:notes');assert.equal(notes.pkg.publisher,'Acme');assert.equal(notes.pkg.license,'MIT');
  assert.deepEqual(notes.pkg.capabilities.skills,['jot']);
  assert.equal(notes.pkg.capabilities.mcpServers[0]!.name,'store');
  assert.deepEqual(notes.pkg.capabilities.hooks,['PreToolUse: echo hi']);
  assert.ok(notes.pkg.compatibility.supported);
  assert.ok(notes.pkg.compatibility.unsupported.some(item=>/output styles/.test(item)),'unknown manifest fields are listed');
  assert.ok(notes.pkg.compatibility.unsupported.some(item=>/hooks/.test(item)));
  const escape=catalog.find(entry=>entry.pkg.name==='escape')!;
  assert.ok(!escape.dir);assert.equal(escape.pkg.compatibility.supported,false);
  const remote=catalog.find(entry=>entry.pkg.name==='remote')!;
  assert.ok(!remote.dir);assert.match(remote.pkg.compatibility.unsupported[0]!,/remote source/);
});

test('a folder of skills is a source; symlinks out of a package and oversize manifests are refused',async t=>{
  const root=await directory(t),outside=await directory(t);
  await put(join(root,'skills','alpha','SKILL.md'),'---\nname: alpha\ndescription: A\n---\nbody');
  const catalog=await readCatalog(root,{id:'s',label:'skills'});
  assert.deepEqual(catalog.map(entry=>[entry.pkg.name,entry.pkg.kind]),[['alpha','skill']]);
  await put(join(outside,'secret'),'x');
  await symlink(join(outside,'secret'),join(root,'skills','alpha','leak'));
  await assert.rejects(packageFiles(join(root,'skills','alpha')),/points outside the package/);
  const big=await directory(t);
  await put(join(big,'.claude-plugin','marketplace.json'),json({plugins:[{name:'x',source:'./x'}]}));
  await put(join(big,'x','.claude-plugin','plugin.json'),`{"name":"x","pad":"${'a'.repeat(300*1024)}"}`);
  const [entry]=await readCatalog(big,{id:'b',label:'big'});
  assert.equal(entry!.pkg.compatibility.supported,false);
  assert.ok(entry!.pkg.compatibility.unsupported.some(item=>/larger than/.test(item)));
  assert.throws(()=>normalizeGitUrl('file:///etc'),/https/);
  assert.equal(normalizeGitUrl('acme/market'),'https://github.com/acme/market.git');
});

test('install stages then renames atomically; a failure leaves neither staging nor target behind',async t=>{
  const root=await directory(t),dataDir=await directory(t);await marketplace(root);
  const catalog=await readCatalog(root,{id:'src1',label:'acme'});
  const entry=catalog.find(item=>item.pkg.name==='notes')!;
  await assert.rejects(installPackage(dataDir,entry,{},()=>{throw new Error('disk full');}),/disk full/);
  assert.deepEqual(await readdir(join(dataDir,'extensions')),[],'nothing half-installed');
  let staged='';
  const done=await installPackage(dataDir,entry,{commit:'abc1234'},staging=>{staged=staging;});
  assert.equal(done.path,join(dataDir,'extensions','notes@1.0.0'));
  assert.ok(!existsSync(staged));
  const manifest=JSON.parse(await readFile(join(done.path,'muster-manifest.json'),'utf8'));
  assert.equal(manifest.sha256,done.sha256);assert.equal(manifest.source.commit,'abc1234');assert.equal(manifest.schema,1);
  assert.match(done.sha256,/^[0-9a-f]{64}$/);
  await assert.rejects(installPackage(dataDir,catalog.find(item=>item.pkg.name==='escape')!,{}),/escapes/);
});

test('git sources clone at a pinned commit',async t=>{
  const repo=await directory(t),dataDir=await directory(t);
  const git=(...args:string[])=>execFileSync('git',['-c','user.email=t@t','-c','user.name=t',...args],{cwd:repo,encoding:'utf8'}).trim();
  git('init','-q');await put(join(repo,'skills','one','SKILL.md'),'---\nname: one\ndescription: first\n---\nx');git('add','.');git('commit','-qm','one');
  const first=git('rev-parse','HEAD');
  await put(join(repo,'skills','two','SKILL.md'),'---\nname: two\ndescription: second\n---\ny');git('add','.');git('commit','-qm','two');
  git('config','uploadpack.allowReachableSHA1InWant','true');
  const commit=await syncGitSource(dataDir,{id:'g1',url:repo,pinnedCommit:first},{allowFile:true});
  assert.equal(commit,first);
  assert.deepEqual((await readCatalog(join(dataDir,'extension-sources','g1'),{id:'g1',label:'g'})).map(entry=>entry.pkg.name),['one']);
  const head=await syncGitSource(dataDir,{id:'g1',url:repo},{allowFile:true});
  assert.notEqual(head,first);
  assert.deepEqual((await readCatalog(join(dataDir,'extension-sources','g1'),{id:'g1',label:'g'})).map(entry=>entry.pkg.name).sort(),['one','two']);
});

test('domain: install, update keeps the previous version, rollback, enablement gates runs, uninstall',async t=>{
  const root=await directory(t),dataDir=await directory(t);await marketplace(root);
  extensionsOptions.codexCache=join(dataDir,'no-codex-cache');
  extensionsOptions.claudeMarketplaces=join(dataDir,'no-claude-marketplaces');
  t.after(()=>{extensionsOptions.codexCache=undefined;extensionsOptions.claudeMarketplaces=undefined;});
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}],async run(input){inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const source=await service.invoke('extensions.sources.add',{kind:'local',path:root});
  assert.equal(source.packages,3);
  const review=await service.invoke('extensions.review',{packageId:`${source.id}:notes`});
  assert.match(review.permissions.mcp[0]!.detail,/bin\/store --db/);assert.deepEqual(review.permissions.hooks,['PreToolUse: echo hi']);assert.deepEqual(review.errors,[]);
  const installed=await service.invoke('extensions.install',{packageId:`${source.id}:notes`});
  assert.equal(installed.state,'Ready');assert.equal(installed.version,'1.0.0');
  await assert.rejects(service.invoke('extensions.install',{packageId:`${source.id}:notes`}),/already installed/);

  const chat=await service.invoke('chat.create',{});
  const send=async(text:string)=>{const before=inputs.length;await service.invoke('chat.send',{id:chat.id,text,requestId:text});for(let i=0;i<500&&inputs.length===before;i++)await new Promise(resolve=>setTimeout(resolve,2));return inputs.at(-1)!;};
  let input=await send('one');
  assert.match(input.developerInstructions??'',/- notes:jot — Jot things \(.*SKILL\.md\)/,'enabled skills are indexed by name, one line and path');
  assert.doesNotMatch(input.developerInstructions??'',/NOTES-SKILL-BODY/,'skill bodies are not re-sent on every turn');
  assert.equal(input.configOverrides?.['mcp_servers.notes_store.command'],join(installed.path,'bin','store'));

  await marketplace(root,'1.1.0');
  const catalog=await service.invoke('extensions.catalog',undefined);
  assert.equal(catalog.find(pkg=>pkg.name==='notes')!.installed?.updateAvailable,true,'local sources are re-read live');
  const updated=await service.invoke('extensions.update',{id:'notes'});
  assert.equal(updated.version,'1.1.0');assert.deepEqual(updated.previous.map(entry=>entry.version),['1.0.0']);
  assert.ok(existsSync(installed.path),'previous version kept for rollback');
  const rolled=await service.invoke('extensions.rollback',{id:'notes'});
  assert.equal(rolled.version,'1.0.0');assert.equal(rolled.previous[0]!.version,'1.1.0');

  await service.invoke('extensions.enablement.set',{extensionId:'notes',scope:'user',scopeId:'',enabled:false});
  assert.equal((await service.invoke('extensions.installed',undefined))[0]!.state,'Installed');
  input=await send('two');
  assert.doesNotMatch(input.developerInstructions??'',/notes:jot/);
  assert.equal(input.configOverrides?.['mcp_servers.notes_store.command'],undefined);
  const listed=await service.invoke('plugins.list',{});
  assert.ok(!listed.some(skill=>skill.provenance==='extension:notes'),'disabled extension skills leave the composer list');

  await service.invoke('extensions.uninstall',{id:'notes'});
  assert.deepEqual(await service.invoke('extensions.installed',undefined),[]);
  assert.deepEqual((await readdir(join(dataDir,'extensions'))).filter(name=>!name.startsWith('.')),[]);
  assert.deepEqual(await service.invoke('extensions.enablement.list',undefined),[]);
});

test('domain: enabled skills reach a run as a short index, never as bodies cut by the hook merge cap',async t=>{
  const root=await directory(t),dataDir=await directory(t);
  const big='x'.repeat(5*1024);
  await put(join(root,'.claude-plugin','marketplace.json'),json({name:'acme',owner:{name:'Acme'},plugins:[{name:'twin',source:'./plugins/twin',version:'1.0.0'}]}));
  const dir=join(root,'plugins','twin');
  await put(join(dir,'.claude-plugin','plugin.json'),json({name:'twin',version:'1.0.0'}));
  await put(join(dir,'skills','one','SKILL.md'),`---\nname: one\ndescription: One\n---\n\n${big}\n`);
  await put(join(dir,'skills','two','SKILL.md'),`---\nname: two\ndescription: Two\n---\n\n${big}\n`);
  extensionsOptions.codexCache=join(dataDir,'no-codex-cache');
  extensionsOptions.claudeMarketplaces=join(dataDir,'no-claude-marketplaces');
  t.after(()=>{extensionsOptions.codexCache=undefined;extensionsOptions.claudeMarketplaces=undefined;});
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}],async run(input){inputs.push(input);return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const source=await service.invoke('extensions.sources.add',{kind:'local',path:root});
  await service.invoke('extensions.install',{packageId:`${source.id}:twin`});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:'go'});
  for(let i=0;i<500&&!inputs.length;i++)await new Promise(resolve=>setTimeout(resolve,2));
  const text=inputs.at(-1)?.developerInstructions??'';
  assert.ok(Buffer.byteLength(text)<=PROMPT_CONTRIBUTION_MAX_BYTES,'the domain budgets below what the hook merge allows, so it never gets cut');
  assert.ok(!text.includes('[truncated]'),'the domain stops adding skill blocks before the hook has to truncate one');
  assert.match(text,/- twin:one — One \(.*SKILL\.md\)\n- twin:two — Two \(.*SKILL\.md\)/,'each skill is one index line with its path');
  assert.doesNotMatch(text,/xxxxxxxx/,'bodies stay on disk until the agent reads them');
});
