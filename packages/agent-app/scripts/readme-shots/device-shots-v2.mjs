// Devices (#363) v2 visual QA: every device family in its own frame — flat, 3D and the floating PiP card — plus the
// error and setup states. Real renderer in headless Chrome with the fictional bridge from mock.js. Usage:
//   SHOTS_FILE=scripts/readme-shots/device-shots-v2.mjs SHOTS_TMP=<dir> node scripts/readme-shots/shoot.mjs --probe [names…]
const viewport = async (ctx) => { await ctx.cdp.call('Emulation.setFocusEmulationEnabled', {enabled: true}); await ctx.evaluate(`window.dispatchEvent(new Event('focus'))`); await ctx.cdp.call('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 2, mobile: false}); await ctx.sleep(400); };
const IDS = {iphone17pro: '6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A', iphone16e: '1A2B3C4D-1111-4C55-9A0B-1F2E3D4C5B6A', iphonese: '1A2B3C4D-2222-4C55-9A0B-1F2E3D4C5B6A', ipadpro: '9C2D7E1B-4F3A-4B8C-8D9E-0A1B2C3D4E5F', ipad9: '9C2D7E1B-3333-4B8C-8D9E-0A1B2C3D4E5F',
  pixel9: 'emulator-5554', pixelfold: 'emulator-5556', pixeltablet: 'emulator-5558', centrepunch: 'emulator-5560', wear: 'emulator-5562', tv: 'emulator-5564', auto: 'emulator-5566', unknown: 'emulator-5568'};
const tab = (key) => async (ctx) => { await ctx.store(`s.openTab({id:'device:${IDS[key]}',kind:'device',deviceId:'${IDS[key]}',title:'Device'})`); await ctx.sleep(2200); };
const pip = async (ctx) => { await ctx.store(`s.openTab({id:'files:f-taskboard',kind:'files',folderId:'f-taskboard',title:'taskboard'})`); await ctx.sleep(2200); };
const settings = async (ctx) => { await ctx.evaluate(`const h=window.__mockHandlers;h['paperclip.config.get']=()=>({mode:'off',baseUrl:'',hasToken:false,secureStorage:true,companyId:null});h['paperclip.signin.status']=()=>({phase:'idle'});h['paperclip.test']=()=>({ok:false,stage:'network'});h['paperclip.badge']=()=>({connected:false,inbox:0,liveRuns:0,mail:0,chatIds:[],company:null,orgs:{}});`); await ctx.store(`s.openAppSettings('integrations')`); await ctx.sleep(1500); await ctx.evaluate(`const h=[...document.querySelectorAll('.preference-group-title')].find(h=>h.textContent==='Devices');let p=h?.parentElement;while(p&&p.scrollHeight<=p.clientHeight+2)p=p.parentElement;if(h&&p)p.scrollTop+=h.getBoundingClientRect().top-p.getBoundingClientRect().top-24;`); };
const FAMILIES = {
  'iphone-island': {deviceKey: 'iphone17pro'}, 'iphone-notch': {deviceKey: 'iphone16e'}, 'iphone-home': {deviceKey: 'iphonese'},
  'ipad': {deviceKey: 'ipadpro'}, 'ipad-home': {deviceKey: 'ipad9'},
  'pixel': {deviceKey: 'pixel9'}, 'pixel-fold-open': {deviceKey: 'pixelfold'}, 'pixel-fold-folded': {deviceKey: 'pixelfold', folded: true}, 'pixel-tablet': {deviceKey: 'pixeltablet'},
  'centre-punch': {deviceKey: 'centrepunch'}, 'wear-round': {deviceKey: 'wear'}, 'tv': {deviceKey: 'tv'}, 'automotive': {deviceKey: 'auto'}, 'unknown-android': {deviceKey: 'unknown'},
};
export const SHOTS = [];
const add = (name, opts, run) => SHOTS.push({name: `v2-${name}`, local: true, opts, settle: 900, async run(ctx) { await viewport(ctx); await run(ctx); }});
for (const [family, fixture] of Object.entries(FAMILIES)) {
  add(`${family}-flat-dark`, {devices: 'live', ...fixture}, tab(fixture.deviceKey));
  add(`${family}-3d-dark`, {devices: 'live', ...fixture, localStorage: {'muster.deviceView': '3d'}}, async (ctx) => { await tab(fixture.deviceKey)(ctx); await ctx.sleep(1500); });
  add(`${family}-pip-dark`, {devices: 'agent', ...fixture}, pip);
}
for (const family of ['iphone-island', 'ipad', 'pixel']) {
  add(`${family}-flat-light`, {devices: 'live', ...FAMILIES[family], theme: 'light'}, tab(FAMILIES[family].deviceKey));
  add(`${family}-pip-light`, {devices: 'agent', ...FAMILIES[family], theme: 'light'}, pip);
}
add('error-iphone-dark', {devices: 'error', deviceKey: 'iphone17pro'}, tab('iphone17pro'));
add('error-pixel-dark', {devices: 'error', deviceKey: 'pixel9'}, tab('pixel9'));
add('picker-dark', {devices: 'ready'}, async (ctx) => { await ctx.store(`s.openTab({id:'devices',kind:'device',title:'Devices'})`); await ctx.sleep(1800); });
add('setup-picker-dark', {devices: 'off'}, async (ctx) => { await ctx.store(`s.openTab({id:'devices',kind:'device',title:'Devices'})`); await ctx.sleep(1800); });
add('setup-settings-missing-dark', {devices: 'missing'}, settings);
add('setup-settings-ready-light', {devices: 'agent', theme: 'light'}, settings);
