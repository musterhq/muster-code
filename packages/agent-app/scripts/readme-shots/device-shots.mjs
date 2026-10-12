// Devices (#363) visual QA: every state of the Devices surfaces in the real renderer (headless Chrome, fictional
// bridge from mock.js with canvas-drawn device screens). Usage (from packages/agent-app):
//   SHOTS_FILE=scripts/readme-shots/device-shots.mjs SHOTS_TMP=<dir> node scripts/readme-shots/shoot.mjs --probe [names…]
const sizes = {1280: 800, 900: 760};
const viewport = async (ctx, width) => { await ctx.cdp.call('Emulation.setFocusEmulationEnabled', {enabled: true}); await ctx.evaluate(`window.dispatchEvent(new Event('focus'))`); await ctx.cdp.call('Emulation.setDeviceMetricsOverride', {width, height: sizes[width], deviceScaleFactor: 2, mobile: false}); await ctx.sleep(500); };
const settings = async (ctx) => { await ctx.evaluate(`const h=window.__mockHandlers;h['paperclip.config.get']=()=>({mode:'off',baseUrl:'',hasToken:false,secureStorage:true,companyId:null});h['paperclip.signin.status']=()=>({phase:'idle'});h['paperclip.test']=()=>({ok:false,stage:'network'});h['paperclip.badge']=()=>({connected:false,inbox:0,liveRuns:0,mail:0,chatIds:[],company:null,orgs:{}});`); await ctx.store(`s.openAppSettings('integrations')`); await ctx.sleep(1500); await ctx.evaluate(`const h=[...document.querySelectorAll('.preference-group-title')].find(h=>h.textContent==='Devices');let p=h?.parentElement;while(p&&p.scrollHeight<=p.clientHeight+2)p=p.parentElement;if(h&&p)p.scrollTop+=h.getBoundingClientRect().top-p.getBoundingClientRect().top-24;`); };
const tab = (which) => async (ctx) => { await ctx.store(which === 'picker' ? `s.openTab({id:'devices',kind:'device',title:'Devices'})` : `s.openTab({id:'device:'+${JSON.stringify(which)},kind:'device',deviceId:${JSON.stringify(which)},title:'Device'})`); await ctx.sleep(1800); };
const IPHONE = '6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A', IPAD = '9C2D7E1B-4F3A-4B8C-8D9E-0A1B2C3D4E5F';
const STATES = {
  'settings-off': {opts: {devices: 'off'}, run: settings},
  'settings-missing': {opts: {devices: 'missing'}, run: settings},
  'settings-installing': {opts: {devices: 'installing'}, run: settings},
  'settings-failed': {opts: {devices: 'failed'}, run: settings},
  'settings-ready': {opts: {devices: 'agent'}, run: settings},
  'settings-windows': {opts: {devices: 'ready', host: 'win32'}, run: settings},
  'picker-setup': {opts: {devices: 'off'}, run: tab('picker')},
  'picker': {opts: {devices: 'ready'}, run: tab('picker')},
  'picker-empty': {opts: {devices: 'empty'}, run: tab('picker')},
  'live-iphone': {opts: {devices: 'live'}, run: tab(IPHONE)},
  'live-ipad': {opts: {devices: 'tablet'}, run: tab(IPAD)},
  'live-android': {opts: {devices: 'android'}, run: tab('emulator-5554')},
  'starting': {opts: {devices: 'starting'}, run: tab(IPHONE)},
  'error': {opts: {devices: 'error'}, run: tab(IPHONE)},
  'agent-tab': {opts: {devices: 'agent'}, run: tab(IPHONE)},
  // PiP: the agent's device session while another resource tab is on screen; then the card fades into its tab.
  'pip': {opts: {devices: 'agent'}, run: async (ctx) => { await ctx.store(`s.openTab({id:'files:f-taskboard',kind:'files',folderId:'f-taskboard',title:'taskboard'})`); await ctx.sleep(1800); }},
  'fullscreen': {opts: {devices: 'live'}, run: async (ctx) => { await tab(IPHONE)(ctx); await ctx.evaluate(`document.querySelector('[aria-label="Maximize resources"],[aria-label^="Maximize"]')?.click()`); await ctx.sleep(900); }},
};
// 3D: Muster's own bodies; with APPLE_USDZ_DIR set (a local folder holding Apple's two files, never committed), the
// Apple-model path runs end to end in the browser: conversion, then the converted model on screen.
const three = (which, apple, turn) => async (ctx) => {
  if (apple && process.env.APPLE_USDZ_DIR) {
    const {readFileSync} = await import('node:fs');
    const file = readFileSync(`${process.env.APPLE_USDZ_DIR}/${apple === 'ipad' ? 'ipad-pro-space-black' : 'iphone-18-pro-e-sim'}.usdz`).toString('base64');
    const node = apple === 'ipad' ? ['zRrSLDpdYmKeRJQ', 'lsDiIbtoSGSmWWZ'] : ['UBGArkKGrAMRRnj', 'EHjrGDHNHzgNjtE'];
    await ctx.evaluate(`const bin=atob(${JSON.stringify(file)});const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);window.__mockHandlers['devices.model']=()=>({id:'x',bodyNode:'${node[0]}',screenNode:'${node[1]}',usdz:u});window.__mockHandlers['devices.modelStore']=()=>null;`);
  }
  await tab(which)(ctx);
  await ctx.sleep(apple ? 6000 : 2500);
  if (turn) {
    // Drag from the empty stage beside the device: the body turns (and keeps the throw's momentum).
    const r = await ctx.evaluate(`const b=document.querySelector('.device-3d-canvas').getBoundingClientRect();return {x:b.left+b.width*0.08,y:b.top+b.height*0.5};`);
    await ctx.cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1});
    for (let i = 1; i <= 8; i++) { await ctx.cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x + i * 40, y: r.y - i * 6, button: 'left', buttons: 1}); await ctx.sleep(16); }
    await ctx.cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: r.x + 320, y: r.y - 48, button: 'left', clickCount: 1});
    await ctx.sleep(120);
  }
};
STATES['3d-android'] = {opts: {devices: 'android', localStorage: {'muster.deviceView': '3d'}}, run: three('emulator-5554')};
STATES['3d-iphone-own'] = {opts: {devices: 'live', localStorage: {'muster.deviceView': '3d'}}, run: three(IPHONE)};
STATES['3d-ipad-own'] = {opts: {devices: 'tablet', localStorage: {'muster.deviceView': '3d'}}, run: three(IPAD)};
STATES['3d-iphone-apple'] = {opts: {devices: 'agent', localStorage: {'muster.deviceView': '3d'}}, run: three(IPHONE, 'iphone')};
STATES['3d-iphone-apple-turned'] = {opts: {devices: 'agent', localStorage: {'muster.deviceView': '3d'}}, run: three(IPHONE, 'iphone', true)};
STATES['3d-android-turned'] = {opts: {devices: 'android', localStorage: {'muster.deviceView': '3d'}}, run: three('emulator-5554', undefined, true)};
const THEMES = {dark: {}, light: {theme: 'light'}, solarized: {darkTheme: 'solarized-dark'}, contrast: {theme: 'light', lightTheme: 'high-contrast-light'}};
const KEY = ['settings-ready', 'picker', 'live-iphone', 'live-android', 'pip', 'error', 'starting', 'settings-missing'];
export const SHOTS = [];
for (const [state, def] of Object.entries(STATES)) for (const [theme, themeOpts] of Object.entries(THEMES)) for (const width of [1280, 900]) {
  if (theme !== 'dark' && !KEY.includes(state)) continue;
  SHOTS.push({name: `devices-${state}-${theme}-${width}`, local: true, opts: {...def.opts, ...themeOpts}, settle: 900, async run(ctx) { await viewport(ctx, width); await def.run(ctx); }});
}
