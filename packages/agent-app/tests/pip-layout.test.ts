import test from 'node:test';
import assert from 'node:assert/strict';
import {SPRING,clampPipPosition,exceedsDragThreshold,nearestPipCorner,orderByRaise,parsePipCorner,pipCornerOrigin,raiseKey,settlePipDrop,springSettled,springStep,type SpringState} from '../src/renderer/pipLayout.ts';
import {dockedSessions,orderPipSources,raiseSession,computerUi,sessionKey,sessionTabId,type PipSource} from '../src/renderer/computerUse.ts';

const bounds={left:0,top:0,width:1000,height:700},size={width:280,height:190};
const src=(chatId:string,app:string,extra:Partial<PipSource>={}):PipSource=>({chatId,target:'computer',app,label:'',at:1,...extra});

test('drag clamp keeps the cluster inside the window, margins and title bar included',()=>{
  assert.deepEqual(clampPipPosition({x:-500,y:-500},size,bounds),{x:12,y:44});
  assert.deepEqual(clampPipPosition({x:9999,y:9999},size,bounds),{x:1000-12-280,y:700-12-190});
  assert.deepEqual(clampPipPosition({x:300,y:200},size,bounds),{x:300,y:200});
  assert.deepEqual(clampPipPosition({x:Number.NaN,y:Number.NaN},size,bounds),{x:12,y:44});
  // A cluster wider than the window pins to the margin instead of producing a negative range.
  assert.deepEqual(clampPipPosition({x:50,y:50},{width:2000,height:2000},bounds),{x:12,y:44});
});

test('release snaps to the nearest corner of the area and the target is inside it',()=>{
  assert.equal(nearestPipCorner({x:20,y:60},size,bounds),'top-left');
  assert.equal(nearestPipCorner({x:700,y:60},size,bounds),'top-right');
  assert.equal(nearestPipCorner({x:700,y:500},size,bounds),'bottom-right');
  assert.equal(nearestPipCorner({x:10,y:480},size,bounds),'bottom-left');
  const drop=settlePipDrop({x:5000,y:5000},size,bounds);
  assert.equal(drop.corner,'bottom-right');assert.deepEqual(drop.target,pipCornerOrigin('bottom-right',size,bounds));
  assert.deepEqual(pipCornerOrigin('bottom-right',size,bounds),{x:708,y:498});
  assert.equal(parsePipCorner('top-left'),'top-left');assert.equal(parsePipCorner('middle'),undefined);
});

test('a small movement is a click; a larger one is a drag',()=>{
  assert.equal(exceedsDragThreshold({x:0,y:0},{x:2,y:2}),false);
  assert.equal(exceedsDragThreshold({x:0,y:0},{x:4,y:0}),true);
});

test('the settle spring converges on the target without wild overshoot and rests',()=>{
  let state:SpringState={x:180,y:-90,vx:0,vy:0};const target={x:0,y:0};let peak=0,frames=0;
  while(!springSettled(state,target)&&frames<600){state=springStep(state,target,1/60);peak=Math.max(peak,Math.abs(state.x));frames++;}
  assert.ok(springSettled(state,target),'settles');assert.ok(frames<150,`settles within ~2.5s (took ${frames} frames)`);assert.ok(peak<=180,'never overshoots past the start');
  // A stalled frame (long dt) cannot fling the card away.
  const jumped=springStep({x:100,y:0,vx:0,vy:0},target,5);assert.ok(Math.abs(jumped.x)<=100);
  assert.ok(SPRING.restDistance>0);
});

test('z-order: raising a session puts it in front and the previous front goes behind',()=>{
  const a=src('c','Mail'),b=src('c','Notes'),c=src('c','Safari');
  const items=[a,b,c],key=sessionKey;
  assert.deepEqual(orderByRaise(items,key,[]).map(s=>s.app),['Mail','Notes','Safari']);
  const afterNotes=raiseKey([],key(b));
  assert.deepEqual(orderPipSources(items,afterNotes).map(s=>s.app),['Notes','Mail','Safari']);
  const afterSafari=raiseKey(afterNotes,key(c));
  assert.deepEqual(orderPipSources(items,afterSafari).map(s=>s.app),['Safari','Notes','Mail']);
  assert.deepEqual(raiseKey(['x','y','z'],'z'),['z','x','y']);assert.equal(raiseKey(['a','b'],'c',2).length,2);
  raiseSession(key(c));assert.equal(computerUi().raised[0],key(c));
});

test('no double visibility: a session whose tab is on screen is docked, every other card stays a PiP',()=>{
  const app=src('c','Mail'),page=src('c','example.com',{target:'browser',url:'https://example.com/',owner:'browser:agent-c',profileId:'personal'});
  assert.equal(sessionTabId(page),'browser:agent-c');
  assert.match(sessionTabId(app),/^live:c:app:mail$/);
  const cards=[app,page];
  assert.equal(dockedSessions(cards,null).size,0,'sidebar closed or on another surface: both PiPs show');
  assert.equal(dockedSessions(cards,'file:repo:a.ts').size,0);
  assert.deepEqual([...dockedSessions(cards,'live:c:app:mail')],[sessionKey(app)]);
  assert.deepEqual([...dockedSessions(cards,'browser:agent-c')],[sessionKey(page)]);
  // Closing the tab returns the session to its PiP.
  assert.equal(dockedSessions(cards,undefined).size,0);
});
