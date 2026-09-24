import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {MenuItemConstructorOptions} from 'electron';
import {buildMenuTemplate,flattenMenu,PRODUCT_NAME,type MenuDeps} from '../src/main/menu.ts';
import {MENU_ACTIONS,type MenuAction} from '../src/shared/menu-protocol.ts';

function deps(overrides:Partial<MenuDeps>={}){
  const sent:MenuAction[]=[];
  const calls:string[]=[];
  const value:MenuDeps={
    isMac:true,isPackaged:true,helpAvailable:false,
    send:action=>{sent.push(action);},
    addFolder:()=>{calls.push('addFolder');},
    stopRun:()=>{calls.push('stopRun');},
    openHelp:()=>{calls.push('openHelp');},
    toggleDevTools:()=>{calls.push('devtools');},
    ...overrides,
  };
  return {value,sent,calls};
}
const click=(item:MenuItemConstructorOptions)=>(item.click as unknown as ()=>void)();
const byLabel=(items:MenuItemConstructorOptions[],label:string)=>{const item=items.find(entry=>entry.label===label);assert.ok(item,`menu item "${label}"`);return item;};
const accelerators=(items:MenuItemConstructorOptions[])=>Object.fromEntries(items.filter(item=>item.label&&item.accelerator).map(item=>[item.label,item.accelerator]));

test('macOS menu carries the product name and the full shortcut contract',()=>{
  const {value,sent}=deps();
  const template=buildMenuTemplate(value);
  assert.deepEqual(template.map(top=>top.label??top.role),[PRODUCT_NAME,'File','Edit','View','Work','windowMenu','help']);
  const items=flattenMenu(template);
  assert.equal(byLabel(items,`About ${PRODUCT_NAME}`).role,'about');
  assert.equal(byLabel(items,`Quit ${PRODUCT_NAME}`).role,'quit');
  assert.deepEqual(accelerators(items),{
    'Settings…':'Cmd+,',
    'New Chat':'CmdOrCtrl+N','Add Folder…':'CmdOrCtrl+O','Close Tab':'CmdOrCtrl+W',
    'Find in Chat':'CmdOrCtrl+F','Focus Composer':'CmdOrCtrl+/',
    'Toggle Sidebar':'CmdOrCtrl+B','Toggle Resources':'Alt+CmdOrCtrl+B','Search Chats':'CmdOrCtrl+K','Command Palette…':'Shift+CmdOrCtrl+P',
    'Back':'CmdOrCtrl+[','Forward':'CmdOrCtrl+]',
    'Stop':'CmdOrCtrl+.','Open Terminal':'CmdOrCtrl+J',
    'Rename Chat':'Alt+CmdOrCtrl+R','Mark as Unread':'Shift+CmdOrCtrl+U','Pin Chat':'Alt+CmdOrCtrl+P','Snooze or Wake Chat…':'Alt+CmdOrCtrl+Z','Archive Chat':'Shift+CmdOrCtrl+A',
    'Next Chat':'Ctrl+Tab','Previous Chat':'Ctrl+Shift+Tab',
    ...Object.fromEntries([1,2,3,4,5,6,7,8,9].map(n=>[`Chat ${n}`,`CmdOrCtrl+${n}`])),
  });
  for(const label of ['Toggle Summary','Copy Chat Link'])assert.ok(byLabel(items,label));
  // Every renderer intent is reachable from exactly one menu item.
  for(const item of items)if(item.click&&item.label&&!['Add Folder…','Stop',`${PRODUCT_NAME} Help`,'Toggle Developer Tools'].includes(item.label))click(item);
  assert.deepEqual([...sent].sort(),[...MENU_ACTIONS].sort());
});

test('Cmd+W sends close-tab instead of closing the window, and main-only actions stay in main',()=>{
  const {value,sent,calls}=deps();
  const items=flattenMenu(buildMenuTemplate(value));
  assert.equal(items.filter(item=>item.role==='close').length,0,'no native close role');
  click(byLabel(items,'Close Tab'));
  assert.deepEqual(sent,['close-tab']);
  click(byLabel(items,'Add Folder…'));click(byLabel(items,'Stop'));
  assert.deepEqual(calls,['addFolder','stopRun']);
});

test('packaged builds hide developer tools and never point Help at an unverified URL',()=>{
  const packaged=flattenMenu(buildMenuTemplate(deps({isPackaged:true}).value));
  assert.ok(!packaged.some(item=>item.label==='Toggle Developer Tools'));
  const help=byLabel(packaged,`${PRODUCT_NAME} Help`);
  assert.equal(help.enabled,false,'no local docs page, so Help is disabled rather than decorative');
  assert.ok(!JSON.stringify(packaged).includes('muster.dev'));
  assert.ok(!JSON.stringify(packaged).includes('Muster Code'));
  const dev=deps({isPackaged:false});
  const devItems=flattenMenu(buildMenuTemplate(dev.value));
  const tools=byLabel(devItems,'Toggle Developer Tools');
  assert.equal(tools.accelerator,'Alt+Cmd+I');
  click(tools);
  assert.deepEqual(dev.calls,['devtools']);
  const local=flattenMenu(buildMenuTemplate(deps({helpAvailable:true}).value));
  assert.equal(byLabel(local,`${PRODUCT_NAME} Help`).enabled,true);
});

test('non-mac menus keep Settings and Quit under File',()=>{
  const items=flattenMenu(buildMenuTemplate(deps({isMac:false}).value));
  assert.equal(byLabel(items,'Settings…').accelerator,'Ctrl+,');
  assert.ok(items.some(item=>item.role==='quit'));
  assert.ok(!items.some(item=>item.role==='about'));
  assert.equal(byLabel(items,'Close Tab').accelerator,'CmdOrCtrl+W');
});
