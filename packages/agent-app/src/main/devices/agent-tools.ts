/**
 * The muster_device agent tools (#363). Offered to a run only while the user has turned on BOTH Devices and the separate
 * "Let agents use devices" setting (the runtime adds the MCP server per agent-mode chat only then), and every call
 * re-checks that consent here, so turning it off mid-run stops the very next call.
 *
 * Same shape as the canvas and terminal tools: a stdio MCP server Codex or Claude Code spawns per chat posts to a
 * 127.0.0.1 endpoint in main guarded by a random bearer token kept in a 0600 file. Because they are ordinary MCP tools,
 * Project tool rules (match "mcp", e.g. `muster_device/device_tap`) and approval prompts apply to them like any other.
 *
 * Safety: the agent sees only what the user can see (device_open makes the session visible as a picture-in-picture
 * card); taps and typing need an open session tied to this chat, are refused in read-only chats, and stop as soon as
 * the user takes control. Screenshots return as images, so they appear in the transcript.
 */
import {randomBytes, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {DEVICE_MCP, deviceTitle, type DeviceSession} from '../../shared/device-protocol.ts';
export {DEVICE_NOTE} from '../../shared/device-protocol.ts';
import {launcherFile, nodeLauncherScript} from '../../runtime/launcher-script.ts';

export interface DeviceToolResult {content: ({type: 'text'; text: string} | {type: 'image'; data: string; mimeType: string})[]; isError?: boolean}
const text = (value: string, isError = false): DeviceToolResult => ({content: [{type: 'text', text: value}], ...(isError ? {isError: true} : {})});

const DEVICE_ARG = {type: 'string', description: 'Device id from device_list.'} as const;
export const DEVICE_TOOL_SPECS = [
  {name: 'device_list', description: 'List the iOS Simulators and Android Emulators on this computer: id, name, OS, whether it is running, and whether a live session is open.', inputSchema: {type: 'object', properties: {}}},
  {name: 'device_open', description: 'Open a live session on a device (boots it first if it is off). The user watches it live in Muster. Call this before tapping or typing.', inputSchema: {type: 'object', properties: {device: DEVICE_ARG}, required: ['device']}},
  {name: 'device_screenshot', description: 'Capture the device screen as a PNG. Coordinates for device_tap are pixels in this image.', inputSchema: {type: 'object', properties: {device: DEVICE_ARG}, required: ['device']}},
  {name: 'device_tap', description: 'Tap the screen at a point given in pixels of the most recent device_screenshot of this device. Needs an open session (device_open).', inputSchema: {type: 'object', properties: {device: DEVICE_ARG, x: {type: 'number', minimum: 0}, y: {type: 'number', minimum: 0}}, required: ['device', 'x', 'y']}},
  {name: 'device_type', description: 'Type text into the focused field on the device (tap the field first). iOS accepts US-keyboard ASCII. Needs an open session.', inputSchema: {type: 'object', properties: {device: DEVICE_ARG, text: {type: 'string', maxLength: 2000}}, required: ['device', 'text']}},
  {name: 'device_apps', description: 'List the apps installed on a running device: bundle id (iOS) or package name (Android) and display name, the user\'s own apps first. Use an id with device_launch_app.', inputSchema: {type: 'object', properties: {device: DEVICE_ARG}, required: ['device']}},
  {name: 'device_launch_app', description: 'Launch an installed app by its bundle id (iOS, e.g. com.apple.Preferences) or package name (Android, e.g. com.android.settings). Needs an open session (device_open). Take a device_screenshot afterwards.', inputSchema: {type: 'object', properties: {device: DEVICE_ARG, app: {type: 'string', description: 'Bundle id or package name from device_apps.', maxLength: 255}}, required: ['device', 'app']}},
  {name: 'device_button', description: 'Press a hardware button: home, back (Android only) or app_switcher. Needs an open session.', inputSchema: {type: 'object', properties: {device: DEVICE_ARG, button: {type: 'string', enum: ['home', 'back', 'app_switcher']}}, required: ['device', 'button']}},
  {name: 'device_close', description: 'Close the live session you opened. The device keeps running.', inputSchema: {type: 'object', properties: {device: DEVICE_ARG}, required: ['device']}},
] as const;
export const DEVICE_TOOL_NAMES = new Set<string>(DEVICE_TOOL_SPECS.map(spec => spec.name));
const MUTATING = new Set(['device_open', 'device_tap', 'device_type', 'device_launch_app', 'device_button', 'device_close']);
const AGENT_BUTTONS: Record<string, 'home' | 'back' | 'appSwitcher'> = {home: 'home', back: 'back', app_switcher: 'appSwitcher'};

/** What the tools need from main: the device manager's methods plus the chat's mode. */
export interface DeviceToolTarget {
  agentAccess(): boolean;
  chat(chatId: string): Promise<{mode: string; permissionMode?: string} | undefined>;
  list(): Promise<{id: string; name: string; platform: string; osVersion: string; state: string}[]>;
  session(id: string): DeviceSession | undefined;
  open(id: string, chatId: string): Promise<DeviceSession>;
  close(id: string): Promise<void>;
  screenshot(id: string): Promise<{png: Buffer; width: number; height: number}>;
  waitForInput(id: string): Promise<boolean>;
  tap(id: string, x: number, y: number): Promise<boolean>;
  type(id: string, value: string): boolean;
  apps(id: string): Promise<{id: string; name: string; user: boolean}[]>;
  launchApp(id: string, app: string): Promise<void>;
  button(id: string, button: 'home' | 'back' | 'appSwitcher'): Promise<void>;
}
const shotSizes = new Map<string, {width: number; height: number}>();
const id = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,140}$/.test(value) && !value.startsWith('-') ? value : null;

/** Runs one device tool call for a chat. Exported for tests. */
export async function runDeviceTool(target: DeviceToolTarget, chatId: string, tool: string, input: unknown): Promise<DeviceToolResult> {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (!target.agentAccess()) return text('The user has not allowed agents to use devices. They can turn it on in Settings › Integrations › Devices.', true);
  const chat = await target.chat(chatId);
  if (!chat) return text('This device server was started for a chat that no longer exists.', true);
  if (MUTATING.has(tool) && (chat.permissionMode ?? 'workspace') === 'read-only') return text('This chat is read-only: you may list devices and take screenshots, but not open, tap or type.', true);
  try {
    if (tool === 'device_list') {
      const devices = await target.list();
      if (!devices.length) return text('No iOS Simulators or Android Emulators were found on this computer.');
      return text(devices.map(device => `${device.id} · ${device.name} · ${device.osVersion} · ${device.state}${target.session(device.id) ? ' · live session open' : ''}`).join('\n'));
    }
    const device = id(args.device);
    if (!device) return text('Pass the device id from device_list.', true);
    const session = target.session(device);
    const foreign = session?.chatId && session.chatId !== chatId;
    switch (tool) {
      case 'device_open': {
        if (foreign) return text('Another chat\'s agent is using this device. Pick another device or ask the user.', true);
        const opened = await target.open(device, chatId);
        const ready = await target.waitForInput(device);
        return text(`Opened ${opened.name}. The user can watch it live in Muster.${ready ? '' : ' Input is still connecting; try device_tap again in a few seconds if it is refused.'} Take a device_screenshot to see the screen.`);
      }
      case 'device_screenshot': {
        const shot = await target.screenshot(device);
        shotSizes.set(device, {width: shot.width, height: shot.height});
        if (shotSizes.size > 64) shotSizes.delete(shotSizes.keys().next().value!);
        return {content: [{type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png'}, {type: 'text', text: `Screenshot ${shot.width}×${shot.height} px.`}]};
      }
      case 'device_apps': {
        const apps = await target.apps(device);
        if (!apps.length) return text('No apps were found on this device.');
        const shown = apps.slice(0, 200);
        return text(shown.map(app => `${app.id} · ${app.name}${app.user ? '' : ' · system'}`).join('\n') + (apps.length > shown.length ? `\n… and ${apps.length - shown.length} more system apps.` : ''));
      }
      case 'device_launch_app': case 'device_button': {
        if (!session) return text('Open the device first with device_open.', true);
        if (foreign) return text('Another chat\'s agent is using this device.', true);
        if (session.control === 'user') return text('The user has taken control of this device. Stop and wait until they hand it back.', true);
        if (tool === 'device_launch_app') {
          if (typeof args.app !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(args.app)) return text('Pass the app\'s bundle id (iOS) or package name (Android); device_apps lists them.', true);
          await target.launchApp(device, args.app);
          return text(`Launched ${args.app}. Take a device_screenshot to see it.`);
        }
        const button = typeof args.button === 'string' ? AGENT_BUTTONS[args.button] : undefined;
        if (!button) return text('Pass button: home, back or app_switcher.', true);
        if (button === 'back' && session.platform === 'ios') return text('iOS has no Back button; use the app\'s own back control or home.', true);
        if (!(await target.waitForInput(device))) return text('The device is not accepting input yet. Try again in a few seconds.', true);
        await target.button(device, button);
        return text(`Pressed ${args.button}.`);
      }
      case 'device_tap': case 'device_type': {
        if (!session) return text('Open the device first with device_open.', true);
        if (foreign) return text('Another chat\'s agent is using this device.', true);
        if (session.control === 'user') return text('The user has taken control of this device. Stop and wait until they hand it back.', true);
        if (!(await target.waitForInput(device))) return text('The device is not accepting input yet. Try again in a few seconds.', true);
        if (tool === 'device_type') {
          if (typeof args.text !== 'string' || !args.text || args.text.length > 2000) return text('Pass the text to type (up to 2000 characters).', true);
          return target.type(device, args.text) ? text(`Typed ${args.text.length} characters.`) : text(session.platform === 'ios' ? 'Only US-keyboard ASCII characters can be typed into an iOS Simulator.' : 'The text could not be sent.', true);
        }
        const size = shotSizes.get(device);
        const x = Number(args.x), y = Number(args.y);
        if (!size) return text('Take a device_screenshot first; tap coordinates are pixels in it.', true);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > size.width || y > size.height) return text(`The point must be inside the ${size.width}×${size.height} screenshot.`, true);
        return await target.tap(device, x / size.width, y / size.height) ? text(`Tapped at ${Math.round(x)}, ${Math.round(y)}.`) : text('The tap could not be sent.', true);
      }
      case 'device_close': {
        if (!session) return text('No session is open on that device.');
        if (session.chatId !== chatId) return text('This session was opened by the user or another chat; leave it open.', true);
        await target.close(device);
        return text(`Closed the session on ${deviceTitle(session)}. The device keeps running.`);
      }
      default: return text(`Unknown device tool ${tool}.`, true);
    }
  } catch (error) { return text(error instanceof Error ? error.message : String(error), true); }
}

/** The stdio MCP server, written as plain CommonJS at start so no build entry is needed. */
export function deviceMcpServerSource(): string {
  return `'use strict';
const fs=require('node:fs');
const TOOLS=${JSON.stringify(DEVICE_TOOL_SPECS)};
const endpointFile=process.argv[2],chatId=process.env.MUSTER_CHAT_ID||'';
const text=(t,isError)=>({content:[{type:'text',text:t}],...(isError?{isError:true}:{})});
async function call(tool,args){
  const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({chatId,tool,arguments:args}),signal:AbortSignal.timeout(330000)});
  if(!response.ok)throw new Error('device host answered '+response.status);
  return await response.json();
}
const write=line=>{process.stdout.write(line+'\\n');};
async function handle(message){
  const respond=body=>{if(message.id!==undefined&&message.id!==null)write(JSON.stringify({jsonrpc:'2.0',id:message.id,...body}));};
  switch(message.method){
    case 'initialize':respond({result:{protocolVersion:typeof (message.params||{}).protocolVersion==='string'?message.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'${DEVICE_MCP}',title:'Muster devices',version:'1.0.0'},instructions:'Shows and drives iOS Simulators and Android Emulators the user watches live in Muster.'}});return;
    case 'ping':respond({result:{}});return;
    case 'tools/list':respond({result:{tools:TOOLS}});return;
    case 'tools/call':{const name=typeof (message.params||{}).name==='string'?message.params.name:'';let result;try{result=await call(name,(message.params||{}).arguments||{});}catch(error){result=text('Muster devices are not reachable: '+(error&&error.message||String(error))+'. Is Muster still open?',true);}respond({result});return;}
    default:if(typeof message.method==='string'&&message.method.startsWith('notifications/'))return;respond({error:{code:-32601,message:'Method not found: '+String(message.method)}});
  }
}
let buffer='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>8*1024*1024)buffer='';let index;while((index=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let message;try{message=JSON.parse(line);}catch{write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}));continue;}void handle(message);}});
process.stdin.on('end',()=>process.exit(0));
`;
}

const MAX_BODY = 64 * 1024;
/** Local endpoint the per-chat device MCP servers post to. */
export class DeviceToolHost {
  readonly launcher: string;
  private server?: http.Server;
  private token = randomBytes(32);
  private disposed = false;
  constructor(private readonly options: {dir: string; execPath: string; target: DeviceToolTarget}) { this.launcher = launcherFile(path.join(options.dir, 'muster-device-mcp')); }
  async start(): Promise<string> {
    fs.mkdirSync(this.options.dir, {recursive: true, mode: 0o700});
    const server = http.createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    server.unref();
    const {port} = server.address() as {port: number};
    const endpoint = path.join(this.options.dir, 'device-endpoint.json'), script = path.join(this.options.dir, 'muster-device-mcp.cjs');
    fs.writeFileSync(endpoint, JSON.stringify({url: `http://127.0.0.1:${port}/v1/call`, token: this.token.toString('hex')}), {mode: 0o600});
    fs.chmodSync(endpoint, 0o600);
    fs.writeFileSync(script, deviceMcpServerSource(), {mode: 0o600});
    fs.writeFileSync(this.launcher, nodeLauncherScript(this.options.execPath, script, endpoint), {mode: 0o700});
    fs.chmodSync(this.launcher, 0o700);
    return this.launcher;
  }
  private authorized(header: string | undefined): boolean {
    const presented = Buffer.from(/^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1] ?? '', 'hex');
    return presented.length === this.token.length && timingSafeEqual(presented, this.token);
  }
  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/v1/call' || !this.authorized(request.headers.authorization)) { reply(403, {error: 'Forbidden'}); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > MAX_BODY) { reply(413, {error: 'Too large'}); return; } chunks.push(chunk as Buffer); }
    let body: {chatId?: unknown; tool?: unknown; arguments?: unknown};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, {error: 'Invalid JSON'}); return; }
    reply(200, await this.call(body.chatId, body.tool, body.arguments));
  }
  call(chatId: unknown, tool: unknown, args: unknown): Promise<DeviceToolResult> {
    if (this.disposed) return Promise.resolve(text('Muster is closing.', true));
    if (typeof chatId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(chatId)) return Promise.resolve(text('This device server was started without a chat.', true));
    if (typeof tool !== 'string' || !DEVICE_TOOL_NAMES.has(tool)) return Promise.resolve(text(`Unknown device tool ${String(tool)}.`, true));
    return runDeviceTool(this.options.target, chatId, tool, args);
  }
  dispose(): void { this.disposed = true; this.server?.close(); this.server = undefined; }
}
