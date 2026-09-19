import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentEvent, Chat, Commands, TimelineItem } from '../shared/protocol.ts';
import { discoverLocalProviders } from './provider-discovery.ts';
import { CustomProviders } from './custom-providers.ts';
import { AgentStore } from './store.ts';
import { WorkspaceWatchService } from './workspace-watch.ts';
import {appendCommandOutput,finishCommandOutput} from './command-output-buffer.ts';
import { toolEventDetails } from './tool-event-details.ts';
import { applyProviderEvent } from './context-telemetry.ts';
import { listFiles, readFile } from './files.ts';
import { readAsset } from './file-assets.ts';
import { AgentModeReviewHost } from './review.ts';
import { createProviderAdapter, MODEL, type ProviderAdapter } from './provider.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid command input.');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) throw new Error(`Invalid ${field}.`);
  return value;
}
function id(value: unknown): string {
  const result = text(value, 'id', 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error('Invalid id.');
  return result;
}
function detail(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 65536);
  try { return JSON.stringify(value ?? {}).slice(0, 65536); } catch { return 'Details unavailable'; }
}
interface ActiveRun { cwd: string; stopped: boolean; promise?: Promise<void> }
interface PendingApproval { chatId: string; resolve(approved: boolean): void; timer: ReturnType<typeof setTimeout> }

export function createAgentService(options: { dataDir: string; onEvent(event: AgentEvent): void; provider?: ProviderAdapter }) {
  const store = new AgentStore(options.dataDir);
  const customProviders = new CustomProviders(options.dataDir);
  const provider = options.provider ?? createProviderAdapter();
  const runs = new Map<string, ActiveRun>();
  const approvals = new Map<string, PendingApproval>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  store.recoverOrphanedRuns();
  const emit = (event: AgentEvent) => { if (!disposed) options.onEvent(event); };
  const watchedFolders = new Set<string>();
  const watcher = new WorkspaceWatchService(
    folderId => emit({type:'workspaceChanged',folderId}),
    (folderId,error) => { watchedFolders.delete(folderId); emit({type:'notice',message:`Live file updates stopped: ${error.message}`}); },
  );
  const state = () => emit({ type: 'snapshot', snapshot: store.snapshot() });
  const timeline = (chatId: string) => emit({ type: 'timeline', chatId, items: store.timeline(chatId) });
  const scheduleTimeline = (chatId: string) => {
    if (!timers.has(chatId)) timers.set(chatId, setTimeout(() => { timers.delete(chatId); if (!disposed) timeline(chatId); }, 33));
  };
  const chatFor = (chatId: string): Chat => { const chat = store.chat(chatId); if (!chat) throw new Error('Chat does not exist.'); return chat; };
  const folderFor = (folderId: unknown) => { const folder = store.folder(id(folderId)); if (!folder) throw new Error('Folder does not exist.'); return folder; };
  function settleApprovals(chatId: string) {
    for (const [approvalId, pending] of approvals) if (pending.chatId === chatId) {
      clearTimeout(pending.timer); approvals.delete(approvalId); pending.resolve(false);
    }
  }
  async function send(chatId: string, prompt: string, requestId: string) {
    const chat = chatFor(chatId);
    const receipt = store.receipt(requestId);
    if (receipt) { if (receipt.chatId !== chatId || receipt.fingerprint !== createHash('sha256').update(prompt).digest('hex')) throw new Error('Request identity conflicts with its original message.'); return {runId: receipt.runId}; }
    if (!prompt.trim()) throw new Error('Write a message first.');
    if (chat.archived) throw new Error('Restore this chat before sending.');
    if (!provider.info().some(p => p.available)) throw new Error('Hybrow provider is unavailable. Your draft is retained.');
    const folder = chat.folderId ? folderFor(chat.folderId) : undefined;
    const project = chat.projectId ? store.snapshot().projects.find(p => p.id === chat.projectId) : undefined;
    const contextualPrompt = project
      ? `Project: ${project.name}\nShared goal: ${project.goal || '(not set)'}\n\nCurrent user request:\n${prompt}`
      : prompt;
    const cwd = folder?.path ?? join(options.dataDir, 'scratch', chatId);
    if (folder) { if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Selected folder is unavailable.'); }
    else await fs.mkdir(cwd, {recursive: true, mode: 0o700});
    if ([...runs.values()].some(run => run.cwd === cwd)) throw new Error('Another chat is working in this folder. Wait or choose a separate folder.');
    const accepted = store.recordSend(chatId, requestId, prompt);
    if (accepted.replay) return {runId: accepted.runId};
    const run: ActiveRun = {cwd, stopped: false}; runs.set(chatId, run); state(); timeline(chatId);
    let segment: TimelineItem | undefined;
    let producedAssistant = false;
    const toolIds = new Map<string, string>();
    const append = (kind: 'assistant' | 'reasoning', delta: string) => {
      if (disposed || !runs.has(chatId) || !delta) return;
      if (kind === 'assistant') producedAssistant = true;
      if (segment && segment.kind !== kind) seal();
      if (!segment) segment = store.appendItem(chatId, kind, '', 'running');
      segment = {...segment, text: segment.text + delta}; store.updateItem(segment.id, segment.text, 'running'); scheduleTimeline(chatId);
    };
    const seal = () => { if (segment) store.updateItem(segment.id, segment.text, 'completed'); segment = undefined; };
    run.promise = (async () => {
      try {
        const result = await provider.run({ chat, cwd, prompt: contextualPrompt, onDelta: delta => append('assistant', delta), onReasoning: delta => append('reasoning', delta),
          onEvent(method, params) {
            if (disposed) return;
            const telemetry = applyProviderEvent(store.contextTelemetry(chatId), method, params);
            if (telemetry) { store.setContextTelemetry(chatId, telemetry); emit({ type: 'contextTelemetry', chatId, telemetry }); }
            const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : params;
            const type = String(item.type ?? '');
            if (type === 'agentMessage' || type === 'reasoning' || type === 'userMessage' || !method.startsWith('item/')) return;
            const itemId = String(item.id ?? params.itemId ?? '');
            if (!itemId) return;
            if (method === 'item/started' || method === 'item/completed') {
              if (!toolIds.has(itemId)) seal();
              const finished = method.endsWith('completed');
              const status = !finished ? 'running' : item.status === 'failed' || item.error != null || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0) ? 'failed' : item.status === 'interrupted' ? 'interrupted' : item.status === 'cancelled' || item.status === 'declined' ? 'cancelled' : 'completed';
              let local = toolIds.get(itemId);
              const previous = local ? store.item(local) : undefined;
              const label = detail(item.command ?? item.title ?? item.name ?? item.tool ?? item.query ?? previous?.data?.name ?? item.type);
              const streamed = typeof previous?.data?.output === 'string' ? previous.data.output : '';
              const supplied = item.aggregatedOutput ?? item.output;
              const finalOutput = supplied == null ? null : typeof supplied === 'string' ? supplied : detail(supplied);
              // Some harnesses finish with only the last output chunk. Preserve an
              // already received stream when it contains that final suffix.
              const buffered=finishCommandOutput({output:streamed,truncated:previous?.data?.outputTruncated===true},finalOutput);
              const output=buffered.output;
              const body = label + (output ? '\n' + output : '');
              const metadata = {...toolEventDetails(item),providerItemId:itemId,type:type || previous?.data?.type,name:label,output,outputTruncated:buffered.truncated};
              if (!local) { local = store.appendItem(chatId, 'tool', body, status, metadata).id; toolIds.set(itemId, local); }
              else store.updateItem(local, body, status, {...store.item(local)?.data,...metadata});
              scheduleTimeline(chatId);
            } else if (method.endsWith('/outputDelta')) {
              const local = toolIds.get(itemId); const previous = local ? store.item(local) : undefined;
              if (previous?.status === 'running') {
                const buffered=appendCommandOutput({output:String(previous.data?.output??''),truncated:previous.data?.outputTruncated===true},String(params.delta??''));
                const output=buffered.output;
                store.updateItem(previous.id, String(previous.data?.name ?? '') + '\n' + output, 'running', {...previous.data, output,outputTruncated:buffered.truncated});
                scheduleTimeline(chatId);
              }
            }
          },
          async onRequest(method, params) {
            seal();
            if (chat.mode !== 'agent' || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return undefined;
            const item = store.appendItem(chatId, 'approval', detail(params.command ?? params.reason ?? params.changes), 'pending', {method});
            const approvalId = item.id;
            timeline(chatId);
            const approved = await new Promise<boolean>(resolve => {
              const timer = setTimeout(() => { approvals.delete(approvalId); resolve(false); }, 10 * 60_000);
              approvals.set(approvalId, {chatId, resolve, timer});
            });
            if (!disposed) { store.updateItem(item.id, item.text, approved ? 'approved' : 'declined'); timeline(chatId); }
            return {decision: approved ? 'accept' : 'decline'};
          },
        });
        if (disposed) return;
        seal();
        if (!producedAssistant && result.finalMessage) store.appendItem(chatId, 'assistant', result.finalMessage, 'completed');
        store.updateChat(chatId, { status: run.stopped ? 'interrupted' : result.status, ...(result.threadId ? {providerThreadId: result.threadId} : {}), ...(result.errorMessage ? {error: result.errorMessage} : {}) });
      } catch (error) {
        if (!disposed) { seal(); const message = error instanceof Error ? error.message : String(error); store.appendItem(chatId, 'notice', message, 'failed'); store.updateChat(chatId, {status: run.stopped ? 'interrupted' : 'failed', error: message}); }
      } finally {
        settleApprovals(chatId); runs.delete(chatId);
        if (!disposed) { const timer = timers.get(chatId); if (timer) clearTimeout(timer); timers.delete(chatId); timeline(chatId); state(); }
      }
    })();
    return {runId: accepted.runId};
  }
  async function invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']> {
    if (disposed) throw new Error('Agent runtime is closed.');
    const result = await dispatch(command, input); return result as Commands[K]['output'];
  }
  async function dispatch(command: string, input: unknown): Promise<unknown> {
    if (command === 'app.snapshot') return store.snapshot();
    if (command === 'providers.list') {
      const detected = await discoverLocalProviders();
      const runtime = provider.info();
      return [...detected.map(({identity, credentialPresent, ...p}) => {
        const runnable = runtime.find(r => r.id === p.id);
        return {...p, source: p.id === 'hybrow' ? 'Local Hybrow profile' : p.id === 'codex' ? 'Local Codex sign-in' : p.id === 'claude-code' ? 'Local Claude Code configuration' : p.id === 'opencode' ? 'Local OpenCode configuration' : 'Host environment',
          canReveal: Boolean(identity), available: Boolean(runnable?.available), models: runnable?.models ?? [],
          ...(runnable?.available ? {status: 'ready', detail: 'Hybrow is enabled for chat execution. Uses your existing local profile; availability and limits depend on the upstream account.'} : {})};
      }), ...customProviders.list()];
    }
    const p = object(input);
    switch (command) {
      case 'folder.add': { const path = await fs.realpath(text(p.path, 'folder path')); if (!(await fs.stat(path)).isDirectory()) throw new Error('Choose a folder.'); const result = store.addFolder(path, basename(path)); state(); return result; }
      case 'chat.create': { const result = store.createChat({folderId: p.folderId === undefined ? undefined : id(p.folderId), projectId: p.projectId === undefined ? undefined : id(p.projectId), model: MODEL, mode: 'agent'}); state(); return result; }
      case 'chat.select': { const chatId = id(p.id); chatFor(chatId); store.setActiveChat(chatId); return store.timeline(chatId); }
      case 'chat.update': {
        const chatId = id(p.id); const chat = chatFor(chatId); const patch: Parameters<AgentStore['updateChat']>[1] = {};
        if (p.title !== undefined) { patch.title = text(p.title, 'title', 256).trim(); if (!patch.title) throw new Error('Title cannot be empty.'); }
        if (p.draft !== undefined) patch.draft = text(p.draft, 'draft', 262144);
        for (const flag of ['pinned', 'archived'] as const) if (p[flag] !== undefined) { if (typeof p[flag] !== 'boolean') throw new Error(`Invalid ${flag}.`); patch[flag] = p[flag]; }
        if (p.mode !== undefined) { if (!['ask','plan','agent'].includes(String(p.mode))) throw new Error('Invalid mode.'); if (chat.status === 'running' || chat.status === 'stopping') throw new Error('Stop this run before changing mode.'); patch.mode = p.mode as Chat['mode']; }
        const result = store.updateChat(chatId, patch); state(); return result;
      }
      case 'chat.movePin': {
        const chatId = id(p.id); chatFor(chatId);
        if (p.direction !== 'up' && p.direction !== 'down') throw new Error('Invalid direction.');
        store.movePin(chatId, p.direction); state(); return;
      }
      case 'chat.send': return send(id(p.id), text(p.text, 'message', 262144), id(p.requestId));
      case 'chat.contextTelemetry': { const chatId = id(p.id); chatFor(chatId); return store.contextTelemetry(chatId); }
      case 'chat.stop': { const chatId = id(p.id); chatFor(chatId); const run = runs.get(chatId); if (!run) return; run.stopped = true; store.updateChat(chatId, {status: 'stopping'}); settleApprovals(chatId); state(); await provider.stop(chatId); return; }
      case 'approval.respond': { const approvalId = id(p.id); if (typeof p.approved !== 'boolean') throw new Error('Invalid approval decision.'); const pending = approvals.get(approvalId); if (!pending) throw new Error('This approval is no longer pending.'); approvals.delete(approvalId); clearTimeout(pending.timer); pending.resolve(p.approved); return; }
      case 'project.create': { const name = text(p.name,'project name',256).trim(); if (!name) throw new Error('Name the Project.'); if (!Array.isArray(p.folderIds) || p.folderIds.length > 100) throw new Error('Invalid Project folders.'); const result = store.createProject(name, text(p.goal,'goal',32768), [...new Set(p.folderIds.map(id))]); state(); return result; }
      case 'workspace.watch': {
        if (!Array.isArray(p.folderIds) || p.folderIds.length > 32) throw new Error('Invalid watched folders.');
        const folders = [...new Set(p.folderIds.map(id))].map(folderFor);
        const desired = new Set(folders.map(folder=>folder.id));
        for (const folderId of watchedFolders) if (!desired.has(folderId)) { watcher.unwatch(folderId); watchedFolders.delete(folderId); }
        await Promise.all(folders.map(async folder => {
          if (watchedFolders.has(folder.id)) return;
          watchedFolders.add(folder.id);
          try { await watcher.watch(folder.id,folder.path); }
          catch (error) { if (watchedFolders.has(folder.id)) { watchedFolders.delete(folder.id); emit({type:'notice',message:`Live file updates unavailable for ${folder.name}: ${(error as Error).message}`}); } }
        }));
        return;
      }
      case 'files.list': return listFiles(folderFor(p.folderId).path, text(p.path ?? '', 'path'));
      case 'files.read': return readFile(folderFor(p.folderId).path, text(p.path,'path'));
      case 'files.asset': return readAsset(folderFor(p.folderId).path, text(p.path,'path'));
      case 'git.changes': { const root = folderFor(p.folderId).path; const result = await new AgentModeReviewHost(() => root).listChanges(); if (result.error) throw new Error(result.error); return result.files; }
      case 'git.diff': { const root = folderFor(p.folderId).path; const result = await new AgentModeReviewHost(() => root).readChange(text(p.path,'path')); if (result.error) throw new Error(result.error); return {path: result.path, before: result.before, after: result.after, truncated: result.truncated}; }
      case 'providers.save': return customProviders.save({name:p.name,endpoint:p.endpoint,apiKeyEnv:p.apiKeyEnv});
      case 'providers.remove': { const key=id(p.id); if(!key.startsWith('custom_')) throw new Error('Discovered connections are managed in their original app.'); customProviders.remove(key); return; }
      case 'providers.check': return customProviders.check(id(p.id));
      case 'providers.reveal': { const key=id(p.id); const info=(await discoverLocalProviders()).find(row=>row.id===key); if(!info?.identity) throw new Error('This connection has no account label to reveal.'); return {identity:info.identity}; }
      default: throw new Error('Unsupported command.');
    }
  }
  return {invoke, async dispose() {
    if (disposed) return;
    watcher.dispose(); watchedFolders.clear();
    for (const [chatId, run] of runs) { run.stopped = true; settleApprovals(chatId); }
    provider.dispose();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...runs.values()].map(run => run.promise)), new Promise(resolve => { deadline = setTimeout(resolve, 2000); })]);
    if (deadline) clearTimeout(deadline);
    disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); customProviders.close(); store.close();
  }};
}
