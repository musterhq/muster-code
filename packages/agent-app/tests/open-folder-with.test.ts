import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createOpenWith} from '../src/main/open-with.ts';
import {chatMenuTemplate,type ChatMenuCommand} from '../src/main/chat-menu.ts';
import {FILES_COMMANDS} from '../src/shared/domains/files-protocol.ts';

// USER-31 / W6-D: open the chat's folder in an installed editor from the chat menu.
const host=(installed:string[],runs:string[][])=>({platform:'darwin' as const,home:'/Users/me',tmp:'/tmp',
  run:async(file:string,args:string[])=>{runs.push([file,...args]);return '';},
  isDirectory:async(path:string)=>path==='/work/repo'||installed.some(name=>path===`/Applications/${name}.app`),
  readFile:async()=>Buffer.alloc(0),remove:async()=>{}});

test('folder apps list installed editors then Finder, and open the folder with open -a', async () => {
  const runs:string[][]=[];
  const openWith=createOpenWith(host(['Cursor','Visual Studio Code','Microsoft Excel'],runs));
  assert.deepEqual((await openWith.folderApps()).map(app=>app.id),['cursor','vscode','finder']);
  await openWith.openFolder('/work/repo','vscode');
  assert.deepEqual(runs.at(-1),['/usr/bin/open','-a','/Applications/Visual Studio Code.app','/work/repo']);
  await openWith.openFolder('/work/repo','finder');
  assert.deepEqual(runs.at(-1),['/usr/bin/open','/work/repo']);
  await assert.rejects(openWith.openFolder('/work/repo','excel'),/cannot open folders/);
  await assert.rejects(openWith.openFolder('/missing','vscode'),/missing/);
  assert.equal(FILES_COMMANDS['files.openFolderWith'],true);
});

test('chat menu offers Open in for a chat with a folder, and Fork', () => {
  const picked:ChatMenuCommand[]=[];
  const chat={id:'c',title:'T',pinned:false,archived:false,draft:'',status:'completed',updatedAt:'',model:'m',mode:'agent',folderId:'f'} as never;
  const template=chatMenuTemplate({chat,folders:[{id:'f',name:'Repo',path:'/r'}],projects:[],surface:'header',openIn:[{id:'cursor',name:'Cursor'},{id:'finder',name:'Finder'}]},command=>picked.push(command));
  const openIn=template.find(item=>item.label==='Open in')!;
  const rows=openIn.submenu as Electron.MenuItemConstructorOptions[];
  assert.deepEqual(rows.map(row=>row.label),['Cursor']);
  (rows[0]!.click as ()=>void)();
  assert.deepEqual(picked.at(-1),{kind:'open-in',app:'cursor'});
  (template.find(item=>item.label==='Fork')!.click as ()=>void)();
  assert.deepEqual(picked.at(-1),{kind:'renderer',action:'fork'});
  const folderless=chatMenuTemplate({chat:{...(chat as object),folderId:undefined} as never,folders:[],projects:[],surface:'sidebar',openIn:[{id:'cursor',name:'Cursor'}]},()=>{});
  assert.equal(folderless.some(item=>item.label==='Open in'),false);
});
