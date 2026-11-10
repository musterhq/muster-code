/**
 * #842: private secret and sudo requests in chat. An agent that needs a password or token calls `request_secret` (in the
 * muster_ask server beside ask_user, or as a native tool on HTTP routes); a `sudo -A` in its shell runs Muster's askpass
 * helper. Both post one private card; the person types the value (or picks it from 1Password) and it goes straight to
 * where it is used:
 *
 *   HTTP routes (Muster runs the commands)   the environment of the run's next commands; never the tool result.
 *   CLI routes (Codex, Claude Code, …)       a 0600 file for this turn, named in the tool result; the CLI's own shell
 *                                             cannot take new environment mid-turn. The file is deleted when the turn ends.
 *   sudo -A                                   the askpass helper's stdout, which only sudo reads.
 *
 * Every value is registered with the redactor (#154) for the life of the app, so if an agent prints it anyway the saved
 * thread, output logs, titles and exports show `••••(NAME)`; on HTTP routes the model also reads the mask. The value is
 * never written to the timeline: cards carry the name, reason and outcome only. One-time is the default; "Remember"
 * stores it in the keychain-backed secret store, per folder or project (sudo: per computer).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TimelineItem } from '../shared/protocol.ts';
import type { ToolSpec } from './governance/tool-host.ts';
import { CHAT_TOKEN_HEADER } from './governance/chat-binding.ts';
import { openSecretStores, SecretStore } from './secret-store.ts';
import { registerRequestedSecret } from './secret-registry.ts';

export const REQUEST_SECRET_TOOL = 'request_secret';
/** The adapter → service request an HTTP route's request_secret call travels as. Waits for the person. */
export const REQUEST_SECRET_METHOD = 'muster/requestSecret';
/** The card's `data.method`. */
export const SECRET_CARD_METHOD = 'muster/secretRequest';
/** The askpass helper's call: a hidden tool on the muster_ask host, never offered to the model. */
export const SUDO_PASSWORD_TOOL = 'sudo_password';
export const SUDO_ASKPASS_ENV = 'SUDO_ASKPASS';
export const SECRET_WAIT_MS = 5 * 60_000;
export const SUDO_WAIT_MS = 2 * 60_000;
/** The provider's wait for one muster_ask call: longer than a secret request can stay open. */
export const ASK_TOOL_TIMEOUT_SEC = Math.ceil(SECRET_WAIT_MS / 1000) + 30;

export const REQUEST_SECRET_SPEC: ToolSpec = {
  name: REQUEST_SECRET_TOOL,
  description: 'Ask the user privately for a password, token or other secret. Muster shows a private card; the user types the value and this call returns once they answer. You never see the value: on this route it is set as an environment variable for your next commands, or put in a file you pass to the command. Never ask for secrets in chat.',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', description: 'What you need, as an environment variable name if possible (e.g. NPM_TOKEN).' },
    reason: { type: 'string', description: 'Why you need it, in one sentence the user can judge.' },
    env: { type: 'string', description: 'The environment variable name to use (optional; defaults to name).' },
  }, required: ['name', 'reason'] },
};
/** One line of agent instructions (agent mode, every access level but read-only). */
export const SECRET_RULE = `Never ask for a password, token or key in chat: call the ${REQUEST_SECRET_TOOL} tool, which asks the user privately. Run sudo as \`sudo -A …\` so Muster asks the user for the password privately (plain sudo has no terminal here). Never print, log or commit a secret.`;

export interface SecretRequestInput { name: string; env: string; reason: string }
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export function parseSecretRequest(args: Record<string, unknown>): SecretRequestInput | string {
  const name = typeof args.name === 'string' ? args.name.trim().replace(/[\x00-\x1f]/g, ' ').slice(0, 128) : '';
  if (!name) return 'request_secret needs a name: what you need, e.g. NPM_TOKEN.';
  const reason = typeof args.reason === 'string' ? args.reason.trim().replace(/[\x00-\x09\x0b-\x1f]/g, ' ').slice(0, 1000) : '';
  if (!reason) return 'request_secret needs a reason the user can judge.';
  const given = typeof args.env === 'string' && args.env.trim() ? args.env.trim() : '';
  if (given && !ENV.test(given)) return 'env must be an environment variable name (letters, digits and _).';
  const env = (given || name.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(?=\d)/, '_') || 'SECRET').slice(0, 64);
  return { name, env, reason };
}

/** What the tool hands back: text for the model (never the value), and, for an HTTP route, environment for its commands. */
export interface SecretReply { text: string; isError?: true; env?: Record<string, string> }
export type SecretRoute = 'env' | 'file';
type Source = 'typed' | '1password' | 'saved';
interface Pending { chatId: string; kind: 'secret' | 'sudo'; route: SecretRoute; input: SecretRequestInput; storeId?: string; expiresAt: number; createdAt: string; timer: ReturnType<typeof setTimeout>; resolve(reply: SecretReply): void }
export interface SecretRequestDeps {
  dataDir: string;
  store: { appendItem(chatId: string, kind: TimelineItem['kind'], text: string, status?: string, data?: Record<string, unknown>): TimelineItem; updateItem(id: string, text: string, status?: string, data?: Record<string, unknown>): void; item(id: string): TimelineItem | undefined };
  /** Timeline and snapshot changed for this chat. */
  changed(chatId: string): void;
  /** Who is asking, for the card (the route's name). */
  requester(chatId: string): string;
  readOnly(chatId: string): boolean;
  /** A run of this chat is live (only a running agent may ask). */
  live(chatId: string): boolean;
  /** Where "Remember" keeps it: the chat's project or folder; null for a chat without either. */
  scope(chatId: string): { key: string; label: string } | null;
  /** The 1Password CLI, when installed. */
  onePassword(): string | undefined;
  secretWaitMs?: number; sudoWaitMs?: number;
}
const hash = (value: string, length = 16) => createHash('sha256').update(value).digest('hex').slice(0, length);
const SUDO_STORE_ID = 'ask--sudo--SUDO_PASSWORD';
const MAX_VALUE = 8192;

export function createSecretRequests(deps: SecretRequestDeps) {
  const pending = new Map<string, Pending>();
  const root = join(deps.dataDir, 'agent-tools', 'secrets');
  const chatDir = (chatId: string) => join(root, hash(chatId, 24));
  let ownStore: SecretStore | undefined;
  // The newest open store that can encrypt (they share one file and keychain in the app); our own only if none is open.
  const keys = () => openSecretStores().findLast(store => store.secureStorage()) ?? openSecretStores().at(-1) ?? (ownStore ??= new SecretStore(deps.dataDir));
  const error = (text: string): SecretReply => ({ text, isError: true });

  function deliver(p: Pick<Pending, 'chatId' | 'kind' | 'route' | 'input'>, value: string): SecretReply {
    registerRequestedSecret(p.kind === 'sudo' ? 'SUDO_PASSWORD' : p.input.env, value);
    if (p.kind === 'sudo') return { text: value };
    const { env, name } = p.input;
    if (p.route === 'env') return { text: `The user entered ${name} privately. $${env} is set in the environment of your next commands in this run. Use "$${env}" where it is needed; never print, log, commit or repeat it.`, env: { [env]: value } };
    const dir = chatDir(p.chatId), file = join(dir, env);
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600);
    return { text: `The user entered ${name} privately. It is in the file '${file}' (only you can read it; Muster deletes it when this turn ends). Pass it to the command that needs it without printing it, for example: ${env}="$(cat '${file}')" your-command. Never print, log, commit or repeat the value.` };
  }
  function close(itemId: string, p: Pending, status: string, data: Record<string, unknown>, reply: SecretReply) {
    if (pending.get(itemId) !== p) return;
    clearTimeout(p.timer); pending.delete(itemId);
    const item = deps.store.item(itemId);
    if (item) deps.store.updateItem(itemId, item.text, status, { ...item.data, ...data });
    deps.changed(p.chatId);
    p.resolve(reply);
  }
  function ask(chatId: string, kind: 'secret' | 'sudo', route: SecretRoute, input: SecretRequestInput, storeId: string | undefined, card: { text: string; data: Record<string, unknown> }): Promise<SecretReply> {
    const saved = storeId ? keys().get(storeId) : undefined;
    if (saved !== undefined) {
      deps.store.appendItem(chatId, 'question', card.text, 'answered', { ...card.data, source: 'saved', storeId });
      deps.changed(chatId);
      return Promise.resolve(deliver({ chatId, kind, route, input }, saved));
    }
    const wait = kind === 'sudo' ? deps.sudoWaitMs ?? SUDO_WAIT_MS : deps.secretWaitMs ?? SECRET_WAIT_MS;
    const expiresAt = Date.now() + wait, createdAt = new Date().toISOString();
    const item = deps.store.appendItem(chatId, 'question', card.text, 'pending', { ...card.data, expiresAt: new Date(expiresAt).toISOString(), ...(storeId ? { storeId } : {}) });
    deps.changed(chatId);
    return new Promise<SecretReply>(resolve => {
      const entry: Pending = { chatId, kind, route, input, ...(storeId ? { storeId } : {}), expiresAt, createdAt, resolve, timer: setTimeout(() => close(item.id, entry, 'expired', { expiredReason: 'timeout' },
        error(kind === 'sudo' ? 'No answer in time: sudo was not given a password.' : `No answer for ${input.name} in time. Continue without it, or tell the user what you need it for and stop.`)), wait) };
      entry.timer.unref?.();
      pending.set(item.id, entry);
    });
  }

  return {
    /** request_secret from either route. Waits for the person; refused in read-only chats and outside a run. */
    request(chatId: string, args: Record<string, unknown>, route: SecretRoute): Promise<SecretReply> {
      if (!deps.live(chatId)) return Promise.resolve(error('This chat has no running turn, so it cannot ask for a secret now.'));
      if (deps.readOnly(chatId)) return Promise.resolve(error('This chat has read-only access, so it cannot ask for secrets. Ask the user to change the access level if the work needs one.'));
      const input = parseSecretRequest(args);
      if (typeof input === 'string') return Promise.resolve(error(input));
      const scope = deps.scope(chatId), requester = deps.requester(chatId), op = Boolean(deps.onePassword());
      const storeId = scope ? `ask--${hash(scope.key, 12)}--${input.env}` : undefined;
      return ask(chatId, 'secret', route, input, storeId, { text: `${requester} asks for ${input.name}`,
        data: { method: SECRET_CARD_METHOD, request: 'secret', name: input.name, env: input.env, reason: input.reason, requester, canRemember: Boolean(scope), rememberLabel: scope ? `Remember for ${scope.label}` : '', onePassword: op } });
    },
    /** The askpass helper: the password goes back to the helper only. */
    sudo(chatId: string, args: Record<string, unknown>): Promise<SecretReply> {
      if (!deps.live(chatId)) return Promise.resolve(error('This chat has no running turn.'));
      if (deps.readOnly(chatId)) return Promise.resolve(error('This chat has read-only access, so sudo is not available.'));
      const prompt = typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 300) : 'sudo asks for your password.';
      const requester = deps.requester(chatId);
      return ask(chatId, 'sudo', 'env', { name: 'sudo password', env: 'SUDO_PASSWORD', reason: prompt }, SUDO_STORE_ID, { text: `${requester} runs sudo`,
        data: { method: SECRET_CARD_METHOD, request: 'sudo', name: 'sudo password', env: '', reason: prompt, requester, canRemember: true, rememberLabel: 'Remember in the keychain', onePassword: Boolean(deps.onePassword()) } });
    },
    async answer(itemId: string, raw: { value?: unknown; onePassword?: unknown; remember?: unknown }): Promise<void> {
      const p = pending.get(itemId);
      if (!p) throw new Error('This request is no longer open.');
      if (Date.now() >= p.expiresAt) throw new Error('This request is no longer open: it timed out.');
      let value: string, source: Source = 'typed';
      if (raw.onePassword !== undefined) {
        const ref = typeof raw.onePassword === 'string' ? raw.onePassword.trim() : '';
        if (!/^op:\/\/[^\s'"]{3,500}$/.test(ref)) throw new Error('Enter a 1Password reference such as op://Vault/Item/field.');
        const op = deps.onePassword();
        if (!op) throw new Error('The 1Password CLI (op) is not installed.');
        value = await new Promise<string>((resolve, reject) => execFile(op, ['read', '--no-newline', ref], { timeout: 90_000, maxBuffer: 64 * 1024 }, (failure, stdout, stderr) => {
          if (failure) reject(new Error(`1Password could not read that reference${String(stderr).trim() ? `: ${String(stderr).trim().split('\n')[0]!.slice(0, 200)}` : '.'}`)); else resolve(String(stdout));
        }));
        source = '1password';
        if (pending.get(itemId) !== p) throw new Error('This request is no longer open.');
      } else value = typeof raw.value === 'string' ? raw.value : '';
      if (!value) throw new Error('Enter the value.');
      if (value.length > MAX_VALUE || /[\0\r\n]/.test(value)) throw new Error('That value cannot be used: it must be one line, without line breaks.');
      const remember = raw.remember === true && Boolean(p.storeId);
      if (remember) {
        try { keys().set(p.storeId!, value); }
        catch (cause) { throw new Error(/spaces/.test(cause instanceof Error ? cause.message : '') ? 'Only a value without spaces or line breaks can be remembered. Send it without Remember.' : cause instanceof Error ? cause.message : String(cause)); }
      }
      close(itemId, p, 'answered', { source, ...(remember ? { remembered: true } : {}) }, deliver(p, value));
    },
    decline(itemId: string): void {
      const p = pending.get(itemId);
      if (!p) throw new Error('This request is no longer open.');
      close(itemId, p, 'dismissed', {}, error(p.kind === 'sudo' ? 'The user declined to give the sudo password.' : `The user declined to share ${p.input.name}. Continue without it, or explain in your reply what you need it for; never ask for the value in chat.`));
    },
    /** Removes a remembered value (the card's Forget). */
    forget(itemId: string): void {
      const storeId = deps.store.item(itemId)?.data?.storeId;
      if (typeof storeId !== 'string' || !storeId.startsWith('ask--')) throw new Error('Nothing is saved for this request.');
      keys().clear(storeId);
      const item = deps.store.item(itemId)!;
      deps.store.updateItem(itemId, item.text, item.status, { ...item.data, forgotten: true });
      deps.changed(item.chatId);
    },
    /** The turn ended: open cards close, files for this chat are deleted. */
    settle(chatId: string): void {
      for (const [itemId, p] of [...pending]) if (p.chatId === chatId) close(itemId, p, 'interrupted', {}, error('The run ended before the user answered.'));
      rmSync(chatDir(chatId), { recursive: true, force: true });
    },
    pendingRequests(): Array<{ itemId: string; chatId: string; createdAt: string; expiresAt: string }> {
      return [...pending].map(([itemId, p]) => ({ itemId, chatId: p.chatId, createdAt: p.createdAt, expiresAt: new Date(p.expiresAt).toISOString() }));
    },
    dispose(): void {
      for (const [itemId, p] of [...pending]) close(itemId, p, 'interrupted', {}, error('Muster is closing.'));
      rmSync(root, { recursive: true, force: true });
      ownStore?.close();
    },
  };
}
export type SecretRequests = ReturnType<typeof createSecretRequests>;

const posixQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** The askpass program sudo -A runs: asks the muster_ask host for the password and prints it to stdout (sudo reads it). */
export function askpassSource(timeoutMs = SUDO_WAIT_MS + 15_000): string {
  return `'use strict';
const fs=require('node:fs');
const endpointFile=process.argv[2],prompt=String(process.argv[3]||'').slice(0,300);
const chatId=process.env.MUSTER_ASKPASS_CHAT||'',chatToken=process.env.MUSTER_ASKPASS_TOKEN||'',key=process.env.MUSTER_ASKPASS_KEY||'';
const fail=message=>{process.stderr.write(message+'\\n');process.exit(1);};
(async()=>{
  let body;
  try{
    const {url,token}=JSON.parse(fs.readFileSync(endpointFile,'utf8'));
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,${JSON.stringify(CHAT_TOKEN_HEADER)}:chatToken,'x-muster-helper-key':key},body:JSON.stringify({chatId,tool:${JSON.stringify(SUDO_PASSWORD_TOOL)},arguments:{prompt}}),signal:AbortSignal.timeout(${Math.max(1000, Math.floor(timeoutMs))})});
    if(!response.ok)throw new Error('Muster answered '+response.status);
    body=await response.json();
  }catch(error){fail('Muster could not ask for the sudo password: '+(error&&error.message?error.message:String(error)));}
  const text=body&&Array.isArray(body.content)&&body.content[0]&&typeof body.content[0].text==='string'?body.content[0].text:'';
  if(!body||body.isError||!text)fail('muster: '+(text||'no password'));
  process.stdout.write(text+'\\n');
})();
`;
}
/** Writes the shared askpass script and this chat's launcher (0700, its chat binding baked in). Returns the launcher path; POSIX only. */
export function writeAskpass(dir: string, execPath: string, endpointFile: string, chatId: string, chatToken: string, helperKey: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const script = join(dir, 'muster-askpass.cjs');
  writeFileSync(script, askpassSource(), { mode: 0o600 });
  const launcher = join(dir, `askpass-${hash(chatId, 16)}`);
  writeFileSync(launcher, `#!/bin/sh\nMUSTER_ASKPASS_CHAT=${posixQuote(chatId)} MUSTER_ASKPASS_TOKEN=${posixQuote(chatToken)} MUSTER_ASKPASS_KEY=${posixQuote(helperKey)} ELECTRON_RUN_AS_NODE=1 exec ${posixQuote(execPath)} ${posixQuote(script)} ${posixQuote(endpointFile)} "$@"\n`, { mode: 0o700 });
  chmodSync(launcher, 0o700);
  return launcher;
}
