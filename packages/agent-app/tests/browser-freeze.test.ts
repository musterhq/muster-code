import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BrowserWorkspaceController} from '../src/main/browser-workspace.ts';

/** PER-04: hidden browser pages are lifecycle-frozen through CDP and thawed before they are shown or used. */
class Debugger {attached=false;commands:{method:string;params:any}[]=[];isAttached(){return this.attached;}attach(){this.attached=true;}sendCommand(method:string,params:any){this.commands.push({method,params});return Promise.resolve({});}}
class Contents extends EventEmitter {
  destroyed=false;debugger=new Debugger();
  navigationHistory={canGoBack:()=>false,canGoForward:()=>false,getAllEntries:()=>[],getActiveIndex:()=>0};
  loadURL(){return Promise.resolve();}
  isDestroyed(){return this.destroyed;}getTitle(){return 'Fixture';}isLoading(){return false;}getZoomFactor(){return 1;}
  setAudioMuted(){}setBackgroundThrottling(){}setWindowOpenHandler(){}reload(){}stop(){}
  close(){this.destroyed=true;this.emit('destroyed');}
  states(){return this.debugger.commands.filter(c=>c.method==='Page.setWebLifecycleState').map(c=>c.params.state).join(',');}
}
class View {webContents=new Contents();setVisible(){}setBackgroundColor(){}setBounds(){}}
class Session extends EventEmitter {setPermissionRequestHandler(){}setPermissionCheckHandler(){}setDevicePermissionHandler(){}setDisplayMediaRequestHandler(){}}

function fixture(options:{freezeHidden?:boolean}={}){
  let clock=1_000;
  const window=Object.assign(new EventEmitter(),{webContents:new Contents(),isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,getContentSize:()=>[1000,800],contentView:{addChildView(){},removeChildView(){}}});
  const views:View[]=[];
  const controller=new BrowserWorkspaceController(window as never,()=>{},{createView(){const view=new View();views.push(view);return view as never;},getSession(){return new Session() as never;}},{...options,now:()=>clock,freezeAfterMs:15_000});
  const tick=(ms=1)=>{clock+=ms;};
  const show=(id:string)=>{tick();controller.position({owner:`browser:${id}`,surfaceId:`m-${id}`,bounds:{x:0,y:0,width:500,height:500}});};
  const hide=(id:string)=>{tick();controller.hide({owner:`browser:${id}`,surfaceId:`m-${id}`});};
  const open=(id:string)=>{tick();controller.open({owner:`browser:${id}`,profileId:'personal',surfaceId:`m-${id}`,url:`https://example.test/${id}`});};
  return {controller,views,show,hide,open,tick};
}

test('a hidden page is frozen, and showing it thaws it first',()=>{
  const {controller,views,show,hide,open}=fixture();
  open('a');show('a');
  assert.equal(views[0].webContents.states(),'','a visible page is never frozen');
  hide('a');
  assert.equal(views[0].webContents.states(),'frozen');
  assert.equal(controller.frozenCount(),1);
  show('a');
  assert.equal(views[0].webContents.states(),'frozen,active');
  assert.equal(controller.frozenCount(),0);
  controller.dispose();
});

test('agent use thaws a hidden page; the sweeper refreezes it once idle',()=>{
  const {controller,views,show,hide,open,tick}=fixture();
  open('a');show('a');hide('a');
  controller.agentPage('browser:a');
  assert.equal(views[0].webContents.states(),'frozen,active');
  assert.equal(controller.freezeIdle(),0,'recently used pages stay awake');
  tick(15_000);
  assert.equal(controller.freezeIdle(),1);
  assert.equal(views[0].webContents.states(),'frozen,active,frozen');
  controller.dispose();
});

test('freezing can be disabled and never runs without a debugger client',()=>{
  const off=fixture({freezeHidden:false});
  off.open('a');off.show('a');off.hide('a');
  assert.equal(off.views[0].webContents.states(),'');
  off.controller.dispose();
  const bare=fixture();
  bare.open('b');(bare.views[0].webContents as any).debugger=undefined;bare.show('b');bare.hide('b');
  assert.equal(bare.controller.frozenCount(),0);
  bare.controller.dispose();
});
