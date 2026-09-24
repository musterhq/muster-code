import test from 'node:test';
import assert from 'node:assert/strict';
import {DISCONNECTED_MS,HIDE_AFTER_MS,PIP_MAX,PIP_MIN,STALE_MS,applyComputerEvent,clampPipWidth,computerUi,cornerPosition,frameFreshness,frameSource,latestComputerShot,pickSource,pipShouldShow,screenshotName,setDocked,setMinimized,setPlacement,snapCorner,toolImageUrl} from '../src/renderer/computerUse.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const area={left:100,top:50,width:800,height:600};
const tool=(id:string,data:Record<string,unknown>,status='completed',at=1000):TimelineItem=>({id,chatId:'c1',kind:'tool',text:'',status,createdAt:new Date(at).toISOString(),data});

test('placement: width clamps to 220–480, drops snap to the nearest corner, corners resolve to fixed positions',()=>{
  assert.equal(clampPipWidth(10),PIP_MIN);assert.equal(clampPipWidth(9999),PIP_MAX);assert.equal(clampPipWidth(Number.NaN),300);
  assert.equal(snapCorner({x:850,y:80},area),'top-right');assert.equal(snapCorner({x:120,y:600},area),'bottom-left');
  const inset={top:12,right:16,bottom:12,left:16},size={width:300,height:220};
  assert.deepEqual(cornerPosition('top-right',area,size,inset),{x:584,y:62});
  assert.deepEqual(cornerPosition('bottom-left',area,size,inset),{x:116,y:418});
  setPlacement({corner:'bottom-right',width:5000});
  assert.deepEqual(computerUi().placement,{corner:'bottom-right',width:PIP_MAX});
});

test('freshness: live under 2s, stale under 10s, then disconnected; ended once the run stops',()=>{
  assert.equal(frameFreshness(STALE_MS-1,true),'live');assert.equal(frameFreshness(STALE_MS,true),'stale');
  assert.equal(frameFreshness(DISCONNECTED_MS,true),'disconnected');assert.equal(frameFreshness(0,false),'ended');
});

test('source selection: newest computer-use step carries the newest screenshot; pushed frames win when fresher',()=>{
  const items=[
    tool('t1',{type:'mcpToolCall',server:'computer-use',tool:'screenshot',arguments:'{"app":"Mail"}',images:[{id:'a'.repeat(32)+'.png',mime:'image/png',bytes:10,width:4,height:2}]},'completed',1000),
    tool('t2',{type:'commandExecution',command:'ls'},'completed',2000),
    tool('t3',{type:'mcpToolCall',server:'computer-use',tool:'click',arguments:'{"app":"Mail","element":"Send"}'},'running',3000),
  ];
  const shot=latestComputerShot(items)!;
  assert.equal(shot.label,'Clicking “Send” in Mail');assert.equal(shot.running,true);assert.equal(shot.itemId,'t3');assert.equal(shot.image?.id,'a'.repeat(32)+'.png');assert.equal(shot.app,'Mail');
  assert.equal(latestComputerShot([items[1]!]),undefined);
  const frame=frameSource({chatId:'c1',owner:'browser:agent-c1',profileId:'personal',dataUrl:'data:image/jpeg;base64,AA',width:2,height:1,url:'https://a.test/x',title:'',action:'Opened a.test',at:5000});
  assert.equal(frame.app,'a.test');assert.equal(pickSource(frame,shot),frame);
  const later={...shot,at:6000,image:undefined};
  const merged=pickSource(frame,later)!;
  assert.equal(merged.label,later.label);assert.equal(merged.image,frame.image);assert.equal(merged.owner,'browser:agent-c1');
  assert.equal(pickSource(undefined,shot),shot);
  assert.ok(pipShouldShow(shot,false,shot.at+HIDE_AFTER_MS-1));assert.ok(!pipShouldShow(shot,false,shot.at+HIDE_AFTER_MS));assert.ok(pipShouldShow(shot,true,1e12));assert.ok(!pipShouldShow(undefined,true,0));
});

test('events: frames are kept per chat (bounded), control owner and agent browser tabs are recorded, dock clears minimize',()=>{
  for(let index=0;index<18;index++) applyComputerEvent({type:'computerFrame',frame:{chatId:`chat${index}`,owner:'o',profileId:'p',dataUrl:'data:image/jpeg;base64,AA',width:1,height:1,url:'https://a.test',title:'A',at:index}});
  assert.equal(Object.keys(computerUi().frames).length,16);assert.ok(!computerUi().frames.chat0);assert.ok(computerUi().frames.chat17);
  applyComputerEvent({type:'computerControl',chatId:'chat17',owner:'user'});
  assert.equal(computerUi().control.chat17,'user');
  applyComputerEvent({type:'computerBrowserOpened',chatId:'chat17',owner:'browser:agent-chat17',profileId:'personal',url:'https://a.test'});
  assert.equal(computerUi().browsers.chat17?.owner,'browser:agent-chat17');
  setMinimized(true);setDocked(true);
  assert.equal(computerUi().minimized,false);assert.equal(computerUi().docked,true);
});

test('screenshots load once by id and export under a readable name',async()=>{
  let loads=0;
  const load=async(id:string)=>{loads++;return {dataUrl:`data:image/png;base64,${id}`};};
  const shot={id:'b'.repeat(32)+'.png'};
  assert.equal(await toolImageUrl(shot,load),`data:image/png;base64,${shot.id}`);
  await toolImageUrl(shot,load);
  assert.equal(loads,1);
  assert.equal(await toolImageUrl({dataUrl:'data:x'},load),'data:x');
  await assert.rejects(toolImageUrl({},load));
  assert.match(screenshotName({app:'Mail',label:'Clicked “Send” in Mail',at:Date.UTC(2026,8,23,10,0,0)},'image/jpeg'),/^mail-clicked-send-in-mail-2026-09-23T10-00-00\.jpg$/);
});
