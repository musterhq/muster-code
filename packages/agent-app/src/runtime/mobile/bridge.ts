/**
 * What a phone may do (#326): the method allowlist, its access checks, and the mapping from the runtime's own types to the
 * slim wire types. The desktop decides everything here; nothing the phone's UI hides is trusted.
 */
import type {ApprovalData, Chat, PendingQuestion, Snapshot, TimelineItem} from '../../shared/protocol.ts';
import {device} from '../../shared/device-noun.ts';
import {ACTING_METHODS, MOBILE_METHODS, MOBILE_PROTOCOL_VERSION, MobileError, type MobileAccess, type MobileApproval, type MobileChat, type MobileChatStatus, type MobileItem, type MobileMethod, type MobileMethods, type MobileNeed, type MobileQuestion} from '../../shared/mobile/protocol.ts';
import type {DomainContext} from '../domains/types.ts';

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
function approvalOf(data: Record<string, unknown> | undefined): MobileApproval | undefined {
  const d = data as Partial<ApprovalData> | undefined;
  if (!d || (d.kind !== 'command' && d.kind !== 'fileChange' && d.kind !== 'mcp')) return undefined;
  const out: MobileApproval = {kind: d.kind};
  if (d.command) out.command = cap(String(d.command));
  if (d.cwd) out.cwd = String(d.cwd);
  if (d.reason) out.reason = String(d.reason).slice(0, 2000);
  if (Array.isArray(d.diff)) out.files = d.diff.map(entry => String(entry.path)).slice(0, 100);
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
  desktopName: string;
  deviceId: string;
  /** Streams this chat's item events to the session (null stops). */
  watch(chatId: string | null): void;
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

const text = (value: unknown, name: string, max = MAX_MESSAGE): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MobileError('bad-request', `Missing or invalid ${name}.`);
  return value;
};
const id = (value: unknown, name = 'id'): string => { if (typeof value !== 'string' || !ID.test(value)) throw new MobileError('bad-request', `Missing or invalid ${name}.`); return value; };

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
  try {
    switch (m) {
      case 'hello': return {desktopName: ctx.desktopName, deviceId: ctx.deviceId, access: ctx.access(), protocol: MOBILE_PROTOCOL_VERSION} satisfies MobileMethods['hello']['result'];
      case 'chats.list': return {chats: mobileChats(await ctx.snapshot())} satisfies MobileMethods['chats.list']['result'];
      case 'chat.open': {
        const chatId = id(p.id);
        await chatOf(chatId);
        const timeline = await ctx.invoke('chat.timeline', {id: chatId});
        ctx.watch(chatId);
        const chat = mobileChats(await ctx.snapshot()).find(entry => entry.id === chatId)!;
        return {chat, items: timeline.items.slice(-OPEN_ITEMS).map(mobileItem), revision: timeline.revision} satisfies MobileMethods['chat.open']['result'];
      }
      case 'chat.close': ctx.watch(null); return {};
      case 'chat.send': {
        const chatId = id(p.id); await chatOf(chatId);
        const result = await ctx.invoke('chat.send', {id: chatId, text: text(p.text, 'message'), requestId: id(p.requestId, 'requestId')});
        return {runId: result.runId} satisfies MobileMethods['chat.send']['result'];
      }
      case 'chat.steer': {
        const chatId = id(p.id); await chatOf(chatId);
        const result = await ctx.invoke('chat.steer', {id: chatId, text: text(p.text, 'message'), requestId: id(p.requestId, 'requestId')});
        return {steered: result.steered, ...(result.reason ? {reason: result.reason} : {})} satisfies MobileMethods['chat.steer']['result'];
      }
      case 'approval.respond': {
        const itemId = id(p.itemId, 'itemId');
        if (p.decision !== 'accept' && p.decision !== 'decline') throw new MobileError('refused', `Approving for the whole session can only be done on ${device().your}. From the phone, approve or decline this one request.`);
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
        await ctx.invoke('question.respond', {id: itemId, answers: shaped});
        return {};
      }
      case 'needs.list': return {needs: await needsList(ctx.invoke, await ctx.snapshot())} satisfies MobileMethods['needs.list']['result'];
    }
  } catch (error) {
    if (error instanceof MobileError) throw error;
    throw new MobileError('failed', (error as Error)?.message?.slice(0, 500) || 'That did not work.');
  }
}
