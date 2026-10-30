// Devices (#363) v3 visual QA: every family (as v2), plus the realistic 3D iPhone and iPad. For those, MODELS_DIR must
// hold the two apple.com files, downloaded and SHA-256 checked the way the app does at runtime (never committed); the
// renderer converts them in the browser exactly as it does in the app.
//   SHOTS_FILE=scripts/readme-shots/device-shots-v3.mjs SHOTS_TMP=<dir> MODELS_DIR=<dir> node scripts/readme-shots/shoot.mjs --probe [names…]
import {readFileSync} from 'node:fs';
import {SHOTS as V2} from './device-shots-v2.mjs';
const IDS = {iphone17pro: '6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A', ipadpro: '9C2D7E1B-4F3A-4B8C-8D9E-0A1B2C3D4E5F'};
const MODELS = {iphone: {file: 'iphone-18-pro-e-sim.usdz', body: 'UBGArkKGrAMRRnj', screen: 'EHjrGDHNHzgNjtE'}, ipad: {file: 'ipad-pro-space-black.usdz', body: 'zRrSLDpdYmKeRJQ', screen: 'lsDiIbtoSGSmWWZ'}};
const real = (key, model, turn) => async (ctx) => {
  await ctx.cdp.call('Emulation.setFocusEmulationEnabled', {enabled: true});
  await ctx.cdp.call('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 2, mobile: false});
  const m = MODELS[model], bytes = readFileSync(`${process.env.MODELS_DIR}/${m.file}`).toString('base64');
  await ctx.evaluate(`const bin=atob(${JSON.stringify(bytes)});const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);window.__mockHandlers['devices.model']=()=>({id:'${model}',bodyNode:'${m.body}',screenNode:'${m.screen}',usdz:u});window.__mockHandlers['devices.modelStore']=()=>null;`);
  await ctx.store(`s.openTab({id:'device:${IDS[key]}',kind:'device',deviceId:'${IDS[key]}',title:'Device'})`);
  await ctx.sleep(9000);
  if (turn) {
    const r = await ctx.evaluate(`const b=document.querySelector('.device-3d canvas').getBoundingClientRect();return {x:b.left+b.width*0.08,y:b.top+b.height*0.5};`);
    await ctx.cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1});
    for (let i = 1; i <= 8; i++) { await ctx.cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x + i * 40, y: r.y - i * 6, button: 'left', buttons: 1}); await ctx.sleep(16); }
    await ctx.cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: r.x + 320, y: r.y - 48, button: 'left', clickCount: 1});
    await ctx.sleep(150);
  }
};
export const SHOTS = [
  ...V2.map(shot => ({...shot, name: shot.name.replace(/^v2-/, 'v3-')})),
  {name: 'v3-iphone-island-3d-real-dark', local: true, opts: {devices: 'live', deviceKey: 'iphone17pro', localStorage: {'muster.deviceView': '3d'}}, settle: 900, run: real('iphone17pro', 'iphone')},
  {name: 'v3-iphone-island-3d-real-turned-dark', local: true, opts: {devices: 'live', deviceKey: 'iphone17pro', localStorage: {'muster.deviceView': '3d'}}, settle: 400, run: real('iphone17pro', 'iphone', true)},
  {name: 'v3-ipad-3d-real-dark', local: true, opts: {devices: 'tablet', deviceKey: 'ipadpro', localStorage: {'muster.deviceView': '3d'}}, settle: 900, run: real('ipadpro', 'ipad')},
  {name: 'v3-ipad-3d-real-turned-dark', local: true, opts: {devices: 'tablet', deviceKey: 'ipadpro', localStorage: {'muster.deviceView': '3d'}}, settle: 400, run: real('ipadpro', 'ipad', true)},
];
