/**
 * What a phone may do (#326): the method allowlist, its access checks, and the mapping from the runtime's own types to the
 * slim wire types. The desktop decides everything here; nothing the phone's UI hides is trusted.
 */
import type {ApprovalData, Chat, PendingQuestion, ProviderInfo, Snapshot, TimelineItem} from '../../shared/protocol.ts';
import {device} from '../../shared/device-noun.ts';
import {ACTING_METHODS, MAX_SEND_ATTACHMENTS, MOBILE_METHODS, MOBILE_PROTOCOL_VERSION, MobileError, type MobileAccess, type MobileApproval, type MobileChat, type MobileChatStatus, type MobileItem, type MobileMethod, type MobileMethods, type MobileNeed, type MobilePlace, type MobileProvider, type MobileQuestion} from '../../shared/mobile/protocol.ts';
import type {DomainContext} from '../domains/types.ts';
import type {PhoneUploads} from './uploads.ts';

const MAX_ITEM_TEXT = 64 * 1024;
const OPEN_ITEMS = 200;
const MAX_MESSAGE = 100_000;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const readOnlyMessage = (): string => `This phone is read only. To let it send, steer and answer, choose Can act for it in Settings › Integrations › Phone on ${device().your}.`;

const STATUSES: ReadonlySet<string> = new Set(['idle', 'running', 'stopping', 'completed', 'failed', 'interrupted']);
export function mobileChats(snapshot: Snapshot): MobileChat[] {
  const needs = new Map((snapshot.attention?.chats ?? []).map(entry => [entry.chatId, entry.requests.length]));
  const folders = new Map(snapshot.folders.map(folder => [folder.id, folder.name]));
  const projects = new Map(snapshot.projects.map(project => [project.id, project.name]));
  return snapshot.chats.filter(chat => !chat.archived).map(chat => {
    const needsYou = needs.get(chat.id) ?? 0;
    const status: MobileChatStatus = needsYou ? 'waiting' : STATUSES.has(chat.status) ? chat.status as MobileChatStatus : 'idle';
    return {id: chat.id, title: chat.title, status, updatedAt: chat.updatedAt, needsYou,
      place: (chat.projectId && projects.get(chat.projectId)) || (chat.folderId && folders.get(chat.folderId)) || null};
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const cap = (text: string) => text.length > MAX_ITEM_TEXT ? `${text.slice(0, MAX_ITEM_TEXT)}\n[truncated]` : text;
const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
/** The phone gets names, never full paths (DESIGN §8.2): the folder's name, and files relative to it (else their base name). */
function phonePath(path: string, cwd: string | undefined): string {
  const absolute = /^(?:[A-Za-z]:)?[\\/]/.test(path) || path.startsWith('~');
  if (!absolute) return path;
  const root = cwd?.replace(/[\\/]+$/, '');
  if (root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) return path.slice(root.length + 1);
  return baseName(path);
}
function approvalOf(data: Record<string, unknown> | undefined): MobileApproval | undefined {
  const d = data as Partial<ApprovalData> | undefined;
  if (!d || (d.kind !== 'command' && d.kind !== 'fileChange' && d.kind !== 'mcp')) return undefined;
  const out: MobileApproval = {kind: d.kind};
  if (d.command) out.command = cap(String(d.command));
  if (d.cwd) out.cwd = baseName(String(d.cwd));
  if (d.reason) out.reason = String(d.reason).slice(0, 2000);
  if (Array.isArray(d.diff)) out.files = d.diff.map(entry => phonePath(String(entry.path), d.cwd ? String(d.cwd) : undefined)).slice(0, 100);
  if (d.server) out.server = String(d.server);
  if (d.tool) out.tool = String(d.tool);
  return out;
}
function questionsOf(data: Record<string, unknown> | undefined): MobileQuestion[] | undefined {
  const list = (data as {questions?: PendingQuestion[]} | undefined)?.questions;
  if (!Array.isArray(list)) return undefined;
  return list.map(q => ({id: String(q.id), header: String(q.header ?? ''), question: String(q.question ?? ''), allowCustomAnswer: Boolean(q.allowCustomAnswer), multiSelect: Boolean(q.multiSelect),
    options: (q.options ?? []).map(option => ({label: String(option.label), ...(option.description ? {description: String(option.description)} : {})})), ...(q.isSecret ? {secret: true} : {})}));
}
export function mobileItem(item: TimelineItem): MobileItem {
  const out: MobileItem = {id: item.id, kind: item.kind, text: cap(item.text ?? ''), createdAt: item.createdAt};
  if (item.status) out.status = item.status;
  if (item.kind === 'approval') { const approval = approvalOf(item.data); if (approval) out.approval = approval; }
  if (item.kind === 'question') { const questions = questionsOf(item.data); if (questions) out.questions = questions; }
  return out;
}
function summary(item: MobileItem): string {
  const a = item.approval;
  if (a) return (a.command ?? (a.tool ? `${a.server ? `${a.server} › ` : ''}${a.tool}` : a.files?.length ? `Change ${a.files.join(', ')}` : item.text)).slice(0, 300);
  return (item.questions?.[0]?.question || item.text).slice(0, 300);
}

/** The runtime calls a phone session may make, after its access was checked. */
export interface BridgeContext {
  invoke: DomainContext['invoke'];
  snapshot(): Promise<Snapshot>;
  access(): MobileAccess;
  /** False once the session closed or the phone was revoked. */
  alive(): boolean;
  desktopName: string;
  deviceId: string;
  /** Streams this chat's item events to the session (null stops). With `deltas`, changes wait until `streamFrom` says what
   *  the phone has, then go out as numbered deltas (phase 3). */
  watch(chatId: string | null, deltas?: boolean): void;
  /** The items the phone got from chat.open: deltas are computed against them from now on. Returns their stream number. */
  streamFrom?(chatId: string, items: MobileItem[]): number;
  /** This phone's uploads and the files it staged (phase 2). */
  uploads?: PhoneUploads;
  /** The desktop's current direct addresses on its network (phase 2). */
  lan?(): string[];
}

export async function needsList(invoke: DomainContext['invoke'], snapshot: Snapshot): Promise<MobileNeed[]> {
  const out: MobileNeed[] = [];
  for (const entry of snapshot.attention?.chats ?? []) {
    let items: TimelineItem[] = [];
    try { items = (await invoke('chat.timeline', {id: entry.chatId})).items; } catch { continue; }
    for (const request of entry.requests) {
      const found = items.find(item => item.id === request.itemId);
      if (!found || (found.kind !== 'approval' && found.kind !== 'question')) continue;
      const item = mobileItem(found);
      out.push({chatId: entry.chatId, chatTitle: entry.chatTitle, itemId: item.id, kind: found.kind, summary: summary(item), createdAt: request.createdAt,
        ...(item.approval ? {approval: item.approval} : {}), ...(item.questions ? {questions: item.questions} : {})});
    }
  }
  return out;
}

/** The desktop's ready providers and the models it offers in the picker, without accounts, endpoints or keys. */
export function mobileProviders(list: ProviderInfo[]): MobileProvider[] {
  return list.filter(entry => entry.available && entry.models.length).map(entry => ({id: entry.id, name: entry.name,
    models: entry.models.filter(model => !model.hiddenByDefault).map(model => ({id: model.id, name: model.name || model.id, images: model.images !== false}))}))
    .filter(entry => entry.models.length);
}
export function mobilePlaces(snapshot: Snapshot): MobilePlace[] {
  return [...snapshot.projects.filter(project => !project.archived).map(project => ({kind: 'project' as const, id: project.id, name: project.name})),
    ...snapshot.folders.filter(folder => !folder.missing).map(folder => ({kind: 'folder' as const, id: folder.id, name: folder.name || baseName(folder.path)}))];
}

const text = (value: unknown, name: string, max = MAX_MESSAGE): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MobileError('bad-request', `Missing or invalid ${name}.`);
  return value;
};
const id = (value: unknown, name = 'id'): string => { if (typeof value !== 'string' || !ID.test(value)) throw new MobileError('bad-request', `Missing or invalid ${name}.`); return value; };

const uploadsOf = (ctx: BridgeContext): PhoneUploads => { if (!ctx.uploads) throw new MobileError('refused', 'Files can’t be sent from this phone yet.'); return ctx.uploads; };

/** Runs one phone request. Throws MobileError for anything the phone should see. */
export async function handle(ctx: BridgeContext, method: unknown, rawParams: unknown): Promise<unknown> {
  if (typeof method !== 'string' || !(MOBILE_METHODS as readonly string[]).includes(method)) throw new MobileError('bad-request', 'Unknown request.');
  const m = method as MobileMethod;
  const p = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
  if (ACTING_METHODS.has(m) && ctx.access() !== 'act') throw new MobileError('read-only', readOnlyMessage());
  const chatOf = async (chatId: string): Promise<Chat> => {
    const chat = (await ctx.snapshot()).chats.find(entry => entry.id === chatId && !entry.archived);
    if (!chat) throw new MobileError('not-found', 'That chat is not on this computer any more.');
    return chat;
  };
  /** Right before a runtime command runs: the session must still be open and allowed to act (it may have changed while
   *  this request awaited a read). */
  const recheck = () => {
    if (!ctx.alive()) throw new MobileError('closed', 'This phone’s session has ended.');
    if (ACTING_METHODS.has(m) && ctx.access() !== 'act') throw new MobileError('read-only', readOnlyMessage());
  };
  try {
    switch (m) {
      case 'hello': return {desktopName: ctx.desktopName, deviceId: ctx.deviceId, access: ctx.access(), protocol: MOBILE_PROTOCOL_VERSION, lan: ctx.lan?.() ?? []} satisfies MobileMethods['hello']['result'];
      case 'chats.list': return {chats: mobileChats(await ctx.snapshot())} satisfies MobileMethods['chats.list']['result'];
      case 'chat.open': {
        const chatId = id(p.id), deltas = p.deltas === true && Boolean(ctx.streamFrom);
        await chatOf(chatId);
        // Watching starts before the read, so a change made while it runs is kept and sent after it, never lost.
        ctx.watch(chatId, deltas);
        const timeline = await ctx.invoke('chat.timeline', {id: chatId});
        const items = timeline.items.slice(-OPEN_ITEMS).map(mobileItem);
        const seq = deltas ? ctx.streamFrom!(chatId, items) : undefined;
        const chat = mobileChats(await ctx.snapshot()).find(entry => entry.id === chatId)!;
        return {chat, items, revision: timeline.revision, ...(seq === undefined ? {} : {seq})} satisfies MobileMethods['chat.open']['result'];
      }
      case 'chat.close': ctx.watch(null); return {};
      case 'chat.send': {
        const chatId = id(p.id); await chatOf(chatId);
        const message = text(p.text, 'message'), requestId = id(p.requestId, 'requestId');
        const attachmentIds = p.attachmentIds === undefined ? [] : Array.isArray(p.attachmentIds) && p.attachmentIds.length <= MAX_SEND_ATTACHMENTS ? p.attachmentIds.map(value => id(value, 'attachment id')) : null;
        // Only files this phone uploaded to this chat: never one staged on the desktop or by another phone.
        if (!attachmentIds || (attachmentIds.length && !ctx.uploads?.owns(chatId, attachmentIds))) throw new MobileError('bad-request', 'That file was not sent from this phone. Attach it again.');
        recheck();
        const result = await ctx.invoke('chat.send', {id: chatId, text: message, requestId, ...(attachmentIds.length ? {attachmentIds} : {})});
        ctx.uploads?.sent(attachmentIds);
        return {runId: result.runId} satisfies MobileMethods['chat.send']['result'];
      }
      case 'chat.steer': {
        const chatId = id(p.id); await chatOf(chatId);
        const message = text(p.text, 'message'), requestId = id(p.requestId, 'requestId');
        recheck();
        const result = await ctx.invoke('chat.steer', {id: chatId, text: message, requestId});
        return {steered: result.steered, ...(result.reason ? {reason: result.reason} : {})} satisfies MobileMethods['chat.steer']['result'];
      }
      case 'approval.respond': {
        const itemId = id(p.itemId, 'itemId');
        if (p.decision !== 'accept' && p.decision !== 'decline') throw new MobileError('refused', `Approving for the whole session can only be done on ${device().your}. From the phone, approve or decline this one request.`);
        recheck();
        await ctx.invoke('approval.respond', {id: itemId, approved: p.decision === 'accept', decision: p.decision});
        return {};
      }
      case 'question.respond': {
        const itemId = id(p.itemId, 'itemId');
        const answers = p.answers && typeof p.answers === 'object' ? p.answers as Record<string, unknown> : null;
        if (!answers || !Object.keys(answers).length) throw new MobileError('bad-request', 'Missing answers.');
        const shaped: Record<string, {answers: string[]}> = {};
        for (const [question, values] of Object.entries(answers)) {
          if (!Array.isArray(values) || values.length > 20 || !values.every(value => typeof value === 'string' && value.length <= 10_000)) throw new MobileError('bad-request', 'Invalid answers.');
          shaped[id(question, 'question id')] = {answers: values as string[]};
        }
        recheck();
        await ctx.invoke('question.respond', {id: itemId, answers: shaped});
        return {};
      }
      case 'chat.options': {
        const [snapshot, providers] = [await ctx.snapshot(), await ctx.invoke('providers.list', {})];
        return {places: mobilePlaces(snapshot), providers: mobileProviders(providers)} satisfies MobileMethods['chat.options']['result'];
      }
      case 'chat.create': {
        const folderId = p.folderId === undefined ? undefined : id(p.folderId, 'folderId'), projectId = p.projectId === undefined ? undefined : id(p.projectId, 'projectId');
        if (folderId && projectId) throw new MobileError('bad-request', 'Choose a folder or a Project, not both.');
        const providerId = id(p.providerId, 'providerId'), model = text(p.model, 'model', 256);
        const snapshot = await ctx.snapshot();
        if (folderId && !snapshot.folders.some(folder => folder.id === folderId && !folder.missing)) throw new MobileError('not-found', 'That folder is not on this computer any more.');
        if (projectId && !snapshot.projects.some(project => project.id === projectId && !project.archived)) throw new MobileError('not-found', 'That Project is not on this computer any more.');
        const offered = mobileProviders(await ctx.invoke('providers.list', {})).find(entry => entry.id === providerId);
        if (!offered || !offered.models.some(entry => entry.id === model)) throw new MobileError('bad-request', 'That model is not available on this computer.');
        recheck();
        const created = await ctx.invoke('chat.create', {...(folderId ? {folderId} : {}), ...(projectId ? {projectId} : {})});
        try { await ctx.invoke('chat.selectProvider', {id: created.id, providerId, model}); }
        catch (error) { await ctx.invoke('chat.delete', {id: created.id, force: true}).catch(() => undefined); throw error; }
        const chat = mobileChats(await ctx.snapshot()).find(entry => entry.id === created.id);
        if (!chat) throw new MobileError('failed', 'The chat was not created.');
        return {chat} satisfies MobileMethods['chat.create']['result'];
      }
      case 'upload.start': {
        const uploads = uploadsOf(ctx), chatId = id(p.chatId, 'chatId'); await chatOf(chatId);
        return uploads.start({chatId, name: p.name, mime: p.mime, size: p.size, sha256: p.sha256}) satisfies MobileMethods['upload.start']['result'];
      }
      case 'upload.chunk': return uploadsOf(ctx).chunk(p.uploadId, p.offset, p.data) satisfies MobileMethods['upload.chunk']['result'];
      case 'upload.cancel': uploadsOf(ctx).cancel(p.uploadId); return {};
      case 'upload.discard': {
        const uploads = uploadsOf(ctx), chatId = id(p.chatId, 'chatId'), attachmentId = id(p.attachmentId, 'attachment id');
        if (!uploads.owns(chatId, [attachmentId])) throw new MobileError('bad-request', 'That file was not sent from this phone.');
        recheck();
        await ctx.invoke('attachments.discard', {chatId, id: attachmentId});
        uploads.sent([attachmentId]);
        return {};
      }
      case 'upload.finish': {
        const uploads = uploadsOf(ctx), file = uploads.finish(p.uploadId);
        await chatOf(file.chatId);
        recheck();
        const ref = await ctx.invoke('attachments.stage', file);
        uploads.own(ref.id, file.chatId);
        return {attachment: {id: ref.id, name: ref.name, mime: ref.mime, size: ref.size, kind: ref.kind}} satisfies MobileMethods['upload.finish']['result'];
      }
      case 'needs.list': return {needs: await needsList(ctx.invoke, await ctx.snapshot())} satisfies MobileMethods['needs.list']['result'];
    }
  } catch (error) {
    if (error instanceof MobileError) throw error;
    throw new MobileError('failed', (error as Error)?.message?.slice(0, 500) || 'That did not work.');
  }
}
