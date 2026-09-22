import { addMemory, listMemory, searchMemory, inspectMemoryStore, isVisibleInScopes } from './memory-adapter.ts';
import { HindsightService } from './hindsight-service.ts';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentEvent, Chat, ChatRecovery, Commands, PendingQuestion, PendingQuestionData, TimelineItem } from '../shared/protocol.ts';
import type { PendingAttentionSummary, AttentionRequest } from '../shared/attention-protocol.ts';
import { discoverLocalProviders } from './provider-discovery.ts';
import { CustomProviders } from './custom-providers.ts';
import { AgentStore } from './store.ts';
import { WorkspaceWatchService } from './workspace-watch.ts';
import {appendCommandOutput,finishCommandOutput} from './command-output-buffer.ts';
import { toolEventDetails } from './tool-event-details.ts';
import { applyProviderEvent } from './context-telemetry.ts';
import { listFiles, readFile, searchFiles } from './files.ts';
import { readAsset } from './file-assets.ts';
import {readDocument} from './document-preview.ts';
import {readWorkbook} from './workbook-preview.ts';
import {FileAnnotations} from './file-annotations.ts';
import {resolveInside} from './paths.ts';
import { AgentModeReviewHost } from './review.ts';
import {gitStatus, mutateGit} from './git-local.ts';
import {createEntry, moveFile} from './file-operations.ts';
import { createProviderAdapter, MODEL, ProviderPreDispatchError, type ProviderAdapter } from './provider.ts';
import { discoverPlugins, discoverSkills, resolveAttachedSkill } from './plugin-library.ts';
import {providerAccessPolicy} from './provider-run-lifecycle.ts';
import {reconcileProviderTurn, type ReconciliationInput, type ReconciliationResult} from './provider-reconciliation.ts';
import { ProjectTaskStore, type TaskStatus } from './project-tasks.ts';

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
interface PendingApproval { chatId: string; createdAt: string; resolve(approved: boolean): void; timer: ReturnType<typeof setTimeout> }
interface PendingQuestionRequest { chatId: string; createdAt: string; providerKey: string; itemId: string; questions: PendingQuestion[]; resolve(answers: Record<string, {answers: string[]}>): void; waiters: Array<(answers: Record<string, {answers: string[]}>) => void>; timer: ReturnType<typeof setTimeout> }

export function createAgentService(options: { dataDir: string; onEvent(event: AgentEvent): void; provider?: ProviderAdapter; reconcileProvider?: (input: ReconciliationInput) => Promise<ReconciliationResult> }) {
  const store = new AgentStore(options.dataDir);
  const projectTasks = new ProjectTaskStore(options.dataDir);
  const customProviders = new CustomProviders(options.dataDir);
  const annotations = new FileAnnotations(options.dataDir);
  const provider = options.provider ?? createProviderAdapter();
  let hindsight: HindsightService | undefined;
  const hindsightClient = () => hindsight ??= new HindsightService({resolveFolderScope(folderId) {
    if (folderId === 'personal') return {kind: 'user', id: 'local'};
    const folder = folderFor(folderId);
    return {kind: 'workspace', id: folder.id};
  }});
  const runs = new Map<string, ActiveRun>();
  const reconciliations = new Set<string>();
  const providerSelections = new Set<string>();
  const approvals = new Map<string, PendingApproval>();
  const questions = new Map<string, PendingQuestionRequest>();
  const questionsByProviderKey = new Map<string, string>();
  let questionSequence = 0;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let closing = false;
  let disposal: Promise<void> | undefined;
  const invocations = new Set<Promise<unknown>>();
  store.recoverOrphanedRuns();
  for (const chat of store.snapshot().chats) {
    for (const item of store.timeline(chat.id)) {
      if ((item.kind === 'question' || item.kind === 'approval') && item.status === 'pending') store.updateItem(item.id, item.text, 'unavailable', item.data);
    }
  }
  const emit = (event: AgentEvent) => { if (!disposed) options.onEvent(event); };
  const watchedFolders = new Set<string>();
  const watcher = new WorkspaceWatchService(
    folderId => emit({type:'workspaceChanged',folderId}),
    (folderId,error) => { watchedFolders.delete(folderId); emit({type:'notice',message:`Live file updates stopped: ${error.message}`}); },
  );
  const snapshot = () => {
    const current = store.snapshot();
    const requests = new Map<string, AttentionRequest[]>();
    const add = (chatId: string, request: AttentionRequest) => {
      const group = requests.get(chatId) ?? []; group.push(request); requests.set(chatId, group);
    };
    // Only an owned live resolver makes a persisted request actionable. Never
    // copy provider payloads, question options, commands, or answers here.
    for (const [itemId, pending] of approvals) add(pending.chatId, {itemId, kind:'approval', createdAt:pending.createdAt, sourceLabel:'Provider approval'});
    for (const [itemId, pending] of questions) add(pending.chatId, {itemId, kind:'question', createdAt:pending.createdAt, sourceLabel:'Provider question'});
    const attention: PendingAttentionSummary = {totalRequests:0, chats:[]};
    for (const chat of current.chats) {
      const items = requests.get(chat.id); if (!items?.length) continue;
      items.sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
      attention.chats.push({chatId:chat.id, chatTitle:chat.title, approvalCount:items.filter(item => item.kind === 'approval').length, questionCount:items.filter(item => item.kind === 'question').length, requests:items});
      attention.totalRequests += items.length;
    }
    attention.chats.sort((a,b) => a.requests[0]!.createdAt.localeCompare(b.requests[0]!.createdAt) || a.chatId.localeCompare(b.chatId));
    return {...current, attention};
  };
  const state = () => emit({ type: 'snapshot', snapshot: snapshot() });
  const publishedTimelineRevisions = new Map<string, number>();
  const timeline = (chatId: string) => {
    const after = publishedTimelineRevisions.get(chatId) ?? 0;
    const patch = store.timelineChanges(chatId, after);
    if (patch.revision > after) {
      publishedTimelineRevisions.set(chatId, patch.revision);
      emit({type: 'timelinePatch', chatId, patch: {...patch, after}});
    }
  };
  const scheduleTimeline = (chatId: string) => {
    if (!timers.has(chatId)) timers.set(chatId, setTimeout(() => { timers.delete(chatId); if (!disposed) timeline(chatId); }, 33));
  };
  const chatFor = (chatId: string): Chat => { const chat = store.chat(chatId); if (!chat) throw new Error('Chat does not exist.'); return chat; };
  projectTasks.recoverUnlinkedRuns();
  for(const task of projectTasks.listRunningTasks()){
    if(!task.runRequestId)continue;
    if(!task.runChatId){projectTasks.failTaskStart({projectId:task.projectId,id:task.id,requestId:task.runRequestId,chatId:'',reason:'The saved Project task run has no linked chat. Reopen it before starting new work.'});continue;}
    const linked=store.chat(task.runChatId);
    if(!linked){projectTasks.failTaskStart({projectId:task.projectId,id:task.id,requestId:task.runRequestId,chatId:task.runChatId,reason:'The linked agent chat is missing. Reopen the task and inspect Project activity before retrying.'});continue;}
    if(linked.status==='completed'||linked.status==='failed'||linked.status==='interrupted')projectTasks.settleRunForChat(linked.id,linked.status,linked.error);
    else if(linked.status==='idle')projectTasks.failTaskStart({projectId:task.projectId,id:task.id,requestId:task.runRequestId,chatId:task.runChatId,reason:'The app stopped before the linked agent chat accepted its request. Open the chat to review the saved draft.'});
  }
  const folderFor = (folderId: unknown) => { const folder = store.folder(id(folderId)); if (!folder) throw new Error('Folder does not exist.'); return folder; };
  const memoryContext = (folderId: unknown) => {
    if (folderId === undefined || folderId === null) return {cwd: options.dataDir, scopes: [{kind:'user',id:'local'}]};
    const folder = folderFor(folderId);
    return {cwd: folder.path, scopes: [{kind:'workspace',id: folder.id}]};
  };
  const requestedMemoryScopes = (value: unknown, expected: Array<{kind:string; id:string}>) => {
    if (!Array.isArray(value) || value.length !== expected.length) throw new Error('Memory scopes must match the selected context.');
    const actual = value.map((entry) => {
      const candidate = object(entry);
      return {kind: text(candidate.kind, 'scope kind', 32), id: text(candidate.id, 'scope id', 128)};
    });
    if (actual.some((scope, index) => scope.kind !== expected[index]!.kind || scope.id !== expected[index]!.id)) throw new Error('Memory scopes must match the selected context.');
    return actual;
  };
  function finishApproval(itemId: string, pending: PendingApproval, approved: boolean, status: string) {
    if (approvals.get(itemId) !== pending) return;
    clearTimeout(pending.timer); approvals.delete(itemId);
    const item = store.item(itemId);
    if (item) store.updateItem(itemId, item.text, status, item.data);
    timeline(pending.chatId); state(); pending.resolve(approved);
  }
  function finishQuestion(itemId: string, pending: PendingQuestionRequest, answers: Record<string, {answers:string[]}>, status: string, receiptAnswers?: Record<string, {answers:string[]}>) {
    if (questions.get(itemId) !== pending) return;
    clearTimeout(pending.timer); questions.delete(itemId);
    if (questionsByProviderKey.get(pending.providerKey) === itemId) questionsByProviderKey.delete(pending.providerKey);
    const item = store.item(itemId);
    if (item) store.updateItem(itemId, item.text, status, receiptAnswers ? {...item.data, answers:receiptAnswers} : item.data);
    timeline(pending.chatId); state();
    pending.resolve(answers); pending.waiters.splice(0).forEach(resolve => resolve(answers));
  }
  function settleApprovals(chatId: string) {
    for (const [itemId, pending] of approvals) if (pending.chatId === chatId) finishApproval(itemId, pending, false, 'interrupted');
  }
  function settleQuestions(chatId: string) {
    for (const [itemId, pending] of questions) if (pending.chatId === chatId) finishQuestion(itemId, pending, {}, 'interrupted');
  }
  function validateRunnableModel(model: string, providerId = 'hybrow') {
    const entry = provider.info().find(candidate => candidate.id === providerId && candidate.available && (candidate.models.some(candidateModel => candidateModel.id === model) || (candidate.models.length === 0 && model === MODEL)));
    if (!entry) throw new Error(`Model ${model} is unavailable through the configured provider. Choose an available model.`);
    return entry;
  }
  async function send(chatId: string, prompt: string, requestId: string, skillId?: string) {
    let chat = chatFor(chatId);
    const folder = chat.folderId ? folderFor(chat.folderId) : undefined;
    const attachedSkill = skillId === undefined ? undefined : await resolveAttachedSkill(skillId, folder ? [folder.path] : []);
    if (skillId !== undefined && !attachedSkill) throw new Error('The selected skill is unavailable or outside this chat’s allowed skill roots. Refresh the skill list and try again.');
    const fingerprint = attachedSkill
      ? createHash('sha256').update(JSON.stringify({ text: prompt, skillId: attachedSkill.id, skillDigest: attachedSkill.digest })).digest('hex')
      : createHash('sha256').update(prompt).digest('hex');
    const receipt = store.receipt(requestId);
    if (receipt) { if (receipt.chatId !== chatId || receipt.fingerprint !== fingerprint) throw new Error('Request identity conflicts with its original message.'); return {runId: receipt.runId}; }
    if (chat.recovery?.kind === 'recovery-needed') throw new Error('This attempt may still be running at the provider. Check its status before sending another message. Your draft is retained.');
    if (!prompt.trim()) throw new Error('Write a message first.');
    if (chat.archived) throw new Error('Restore this chat before sending.');
    if (providerSelections.has(chatId)) throw new Error('Wait for the provider selection to finish.');
    validateRunnableModel(chat.model,chat.providerId??'hybrow');
    const project = chat.projectId ? store.snapshot().projects.find(p => p.id === chat.projectId) : undefined;
    const context = project ? `Project: ${project.name}\nShared goal: ${project.goal || '(not set)'}` : '';
    const skillContext = attachedSkill ? `Selected skill: ${attachedSkill.name} (${attachedSkill.provenance})\n\nApply these user-selected skill instructions to the current request:\n<skill-instructions>\n${attachedSkill.content}\n</skill-instructions>` : '';
    const contextualPrompt = context || skillContext
      ? `${[context, skillContext].filter(Boolean).join('\n\n')}\n\nCurrent user request:\n${prompt}`
      : prompt;
    const cwd = folder?.path ?? join(options.dataDir, 'scratch', chatId);
    if (folder) { if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Selected folder is unavailable.'); }
    else await fs.mkdir(cwd, {recursive: true, mode: 0o700});
    if (closing || disposed) throw new Error('Agent runtime is stopping. No new attempt was dispatched.');
    if ([...runs.values()].some(run => run.cwd === cwd)) throw new Error('Another chat is working in this folder. Wait or choose a separate folder.');
    if (folder && store.snapshot().chats.some(other => other.id !== chatId && other.folderId === folder.id && other.recovery?.kind === 'recovery-needed')) throw new Error('Another chat in this folder has unresolved provider work. Check that chat’s status before starting more work here.');
    // File preflight awaits can overlap a future-run access/mode change. Use
    // the latest policy at the atomic receipt boundary, then keep it immutable.
    chat = chatFor(chatId);
    if (chat.archived) throw new Error('Restore this chat before sending.');
    if (chat.recovery?.kind === 'recovery-needed') throw new Error('Check the unresolved provider attempt before sending. Your draft is retained.');
    if (providerSelections.has(chatId)) throw new Error('Wait for the provider selection to finish.');
    const selectedProvider=validateRunnableModel(chat.model,chat.providerId??'hybrow');
    const bindingId=selectedProvider.bindingId??selectedProvider.id;
    if (chat.providerBindingId && chat.providerBindingId!==bindingId) throw new Error('The selected provider account or profile changed. Select it again before sending. Your draft is retained.');
    const nativeMatches=chat.providerThreadProviderId===selectedProvider.id && chat.providerThreadBindingId===bindingId;
    if (!chat.providerBindingId || (chat.providerThreadId && !nativeMatches)) {
      if (chat.providerThreadId && !nativeMatches) store.appendItem(chatId,'notice','This provider will start a fresh conversation. The displayed chat history is retained.','completed');
      chat=store.updateChat(chatId,{providerId:selectedProvider.id,providerBindingId:bindingId,...(!nativeMatches?{providerThreadId:null,providerTurnId:null,providerThreadProviderId:null,providerThreadBindingId:null}:{})});
    }
    const access = providerAccessPolicy(chat);
    const accepted = store.recordSend(chatId, requestId, prompt, fingerprint);
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
        const persistIdentity = (threadId: string, turnId?: string) => {
          if (disposed || runs.get(chatId) !== run) return;
          if (!threadId || threadId.length > 256 || /[\x00-\x1f]/.test(threadId) || (turnId !== undefined && (!turnId || turnId.length > 256 || /[\x00-\x1f]/.test(turnId)))) throw new Error('The provider returned an invalid attempt identity.');
          const current=store.chat(chatId);
          store.updateChat(chatId,{providerThreadId:threadId,providerThreadProviderId:chat.providerId??'hybrow',providerThreadBindingId:chat.providerBindingId??null,...(turnId ? {providerTurnId:turnId} : current?.providerThreadId !== threadId ? {providerTurnId:null} : {})}); state();
        };
        const result = await provider.run({ chat: {...chat,providerTurnId:undefined,recovery:undefined}, cwd, prompt: contextualPrompt, onDelta: delta => append('assistant', delta), onReasoning: delta => append('reasoning', delta),
          onThreadReady: threadId => persistIdentity(threadId),
          onTurnAccepted: identity => persistIdentity(identity.threadId,identity.turnId),
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
            if (disposed || closing || run.stopped || runs.get(chatId) !== run) return undefined;
            seal();
            if (method === 'item/tool/requestUserInput') {
              const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
              if (rawQuestions.length === 0 || rawQuestions.length > 32) throw new Error('Invalid provider questions.');
              const parsed = rawQuestions.flatMap((raw): PendingQuestion[] => {
                if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid provider question.');
                const value = raw as Record<string, unknown>;
                const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim().slice(0, 128) : '';
                const question = typeof value.question === 'string' ? value.question.slice(0, 4096) : '';
                if (!id || !question) throw new Error('Invalid provider question.');
                const rawOptions = value.options == null ? [] : value.options;
                if (!Array.isArray(rawOptions) || rawOptions.length > 32) throw new Error('Invalid provider question options.');
                const options = rawOptions.flatMap((option): PendingQuestion['options'] => {
                  if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('Invalid provider question option.');
                  const candidate = option as Record<string, unknown>;
                  if (typeof candidate.label !== 'string' || !candidate.label.trim()) throw new Error('Invalid provider question option.');
                  return [{ label: candidate.label.trim().slice(0, 512), ...(typeof candidate.description === 'string' ? { description: candidate.description.slice(0, 2048) } : {}), ...(typeof candidate.value === 'string' ? { value: candidate.value.slice(0, 512) } : {}) }];
                });
                const isOther = typeof value.isOther === 'boolean' ? value.isOther : undefined;
                const isSecret = value.isSecret === true;
                return [{ id, header: typeof value.header === 'string' && value.header.trim() ? value.header.slice(0, 256) : id, question, options, allowCustomAnswer: options.length === 0 || (isOther ?? (value.allowCustomAnswer !== false)), multiSelect: value.multiSelect === true, ...(isOther !== undefined ? {isOther} : {}), ...(isSecret ? {isSecret:true} : {}) }];
              });
              const ids = new Set<string>();
              for (const question of parsed) { if (ids.has(question.id)) throw new Error('Provider question IDs must be unique.'); ids.add(question.id); if (!question.allowCustomAnswer && question.options.length === 0) throw new Error('Provider question has no selectable answer.'); }
              // Codex itemId is the request identity. turnId is only a parent
              // turn and may carry multiple identical questions, so it cannot
              // be used to coalesce requests when itemId is absent.
              const identity = typeof params.itemId === 'string' && params.itemId ? params.itemId : `fallback-${++questionSequence}`;
              const providerKey = `${chatId}:${identity}:${JSON.stringify(parsed)}`;
              const existingId = questionsByProviderKey.get(providerKey);
              const existing = existingId ? questions.get(existingId) : undefined;
              if (existing) {
                if (existing.waiters.length >= 8) throw new Error('Too many duplicate provider question requests.');
                return await new Promise<Record<string, unknown>>(resolve => existing.waiters.push(answers => resolve({ answers })));
              }
              const item = store.appendItem(chatId, 'question', 'The provider needs your input.', 'pending', { method, questions: parsed } satisfies PendingQuestionData);
              timeline(chatId);
              return await new Promise<Record<string, unknown>>(resolve => {
                let pending!: PendingQuestionRequest;
                const timer = setTimeout(() => {
                  finishQuestion(item.id, pending, {}, 'expired');
                }, 10 * 60_000);
                pending = { chatId, createdAt:item.createdAt, providerKey, itemId: item.id, questions: parsed, resolve: answers => resolve({ answers }), waiters: [], timer };
                questions.set(item.id, pending); questionsByProviderKey.set(providerKey, item.id); state();
              });
            }
            if (access.permissionMode !== 'workspace' || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return undefined;
            const item = store.appendItem(chatId, 'approval', detail(params.command ?? params.reason ?? params.changes), 'pending', {method});
            const approvalId = item.id;
            timeline(chatId);
            const approved = await new Promise<boolean>(resolve => {
              let pending!: PendingApproval;
              const timer = setTimeout(() => finishApproval(approvalId, pending, false, 'expired'), 10 * 60_000);
              pending = {chatId, createdAt:item.createdAt, resolve, timer};
              approvals.set(approvalId, pending); state();
            });
            return {decision: approved ? 'accept' : 'decline'};
          },
        });
        if (disposed) return;
        seal();
        if (!producedAssistant && result.finalMessage) store.appendItem(chatId, 'assistant', result.finalMessage, 'completed');
        const recovery: ChatRecovery | undefined = result.recovery ?? (result.status === 'failed' || run.stopped ? {kind:'recovery-needed',retryable:false,reason:'The provider attempt did not settle with confirmed outcome. Check its saved turn before continuing; the prompt was not resent.'} : undefined);
        if (result.threadId) persistIdentity(result.threadId,result.turnId);
        if (recovery) store.appendItem(chatId,'notice',recovery.reason,recovery.kind,{recovery,providerThreadId:store.chat(chatId)?.providerThreadId,providerTurnId:store.chat(chatId)?.providerTurnId});
        const restoreDraft=result.status==='failed' && result.dispatchState==='not-dispatched' && recovery?.kind!=='recovery-needed' && store.chat(chatId)?.draft==='';
        store.updateChat(chatId, {status:recovery?.kind === 'recovery-needed' ? 'failed' : run.stopped ? 'interrupted' : result.status,recovery:recovery ?? null,error:recovery?.reason ?? result.errorMessage ?? null,...(restoreDraft?{draft:prompt}:{})});
      } catch (error) {
        if (!disposed) {
          seal();
          const recovery: ChatRecovery = error instanceof ProviderPreDispatchError
            ? {kind:'failed',retryable:true,reason:error.message}
            : {kind:'recovery-needed',retryable:false,reason:'The provider attempt ended without a confirmed outcome. Check its saved turn before continuing; the prompt was not resent.'};
          store.appendItem(chatId,'notice',recovery.reason,recovery.kind,{recovery});
          store.updateChat(chatId,{status:'failed',error:recovery.reason,recovery,...(error instanceof ProviderPreDispatchError && store.chat(chatId)?.draft===''?{draft:prompt}:{})});
        }
      } finally {
        settleApprovals(chatId); settleQuestions(chatId); runs.delete(chatId);
        if (!disposed) { const timer = timers.get(chatId); if (timer) clearTimeout(timer); timers.delete(chatId); timeline(chatId); const finalChat=store.chat(chatId);if(finalChat&&(finalChat.status==='completed'||finalChat.status==='failed'||finalChat.status==='interrupted')){const task=projectTasks.settleRunForChat(chatId,finalChat.status,finalChat.error);if(task)emit({type:'projectChanged',projectId:task.projectId,taskId:task.id});}state(); }
      }
    })();
    return {runId: accepted.runId};
  }
  const startingProjectTasks=new Map<string,Promise<Commands['project.tasks.start']['output']>>();
  async function startProjectTask(input:Commands['project.tasks.start']['input']):Promise<Commands['project.tasks.start']['output']>{
    const projectId=id(input?.projectId),taskId=id(input?.id),requestId=id(input?.requestId),project=store.snapshot().projects.find(item=>item.id===projectId);
    if(!project)throw new Error('Project not found.');
    const task=projectTasks.assertTaskProject(projectId,taskId);
    if(!Number.isSafeInteger(input.revision)||input.revision<0)throw new Error('Invalid revision.');
    const inFlightKey=`${projectId}:${taskId}:${requestId}`,inFlight=startingProjectTasks.get(inFlightKey);
    if(inFlight)return inFlight;
    if(task.runRequestId===requestId&&task.runChatId){const receipt=store.receipt(requestId);if(!receipt)throw new Error('This task start has no confirmed provider receipt. Open its linked chat and inspect it before retrying.');return {task,chatId:task.runChatId,runId:receipt.runId};}
    if(task.status==='running')throw new Error('This task already has an active run. Open its linked chat.');
    if(task.runChatId&&task.runRequestId){const previous=store.chat(task.runChatId);if(previous&&(previous.status==='running'||previous.status==='stopping'||previous.recovery?.kind==='recovery-needed'))throw new Error('The prior agent attempt may still be active. Open its linked chat and resolve its status before running this task again.');}
    if(project.folderIds.length===0)throw new Error('Attach a folder to this Project before starting an agent task.');
    let folderId=input.folderId===undefined?undefined:id(input.folderId);
    if(folderId&&!project.folderIds.includes(folderId))throw new Error('Choose a folder attached to this Project.');
    if(!folderId&&project.folderIds.length===1)folderId=project.folderIds[0];
    if(!folderId&&project.folderIds.length>1)throw new Error('Choose the folder this task should work in.');
    const run=startProjectTaskOnce({projectId,taskId,revision:input.revision,requestId,folderId});
    startingProjectTasks.set(inFlightKey,run);
    try{return await run;}finally{if(startingProjectTasks.get(inFlightKey)===run)startingProjectTasks.delete(inFlightKey);}
  }
  async function startProjectTaskOnce(input:{projectId:string;taskId:string;revision:number;requestId:string;folderId?:string}):Promise<Commands['project.tasks.start']['output']>{
    const project=store.snapshot().projects.find(item=>item.id===input.projectId)!;
    const task=projectTasks.assertTaskProject(input.projectId,input.taskId);
    projectTasks.assertCanStartTask({projectId:input.projectId,id:input.taskId,revision:input.revision});
    const folder=input.folderId?store.folder(input.folderId):undefined;
    const prompt=`Project task: ${task.title}\nTask ID: ${task.id}\nAcceptance criteria:\n${task.acceptance||'(not specified)'}\n\nWork only within the selected Project folder. Implement the task, report concrete changes and relevant verification, and do not claim the task is verified. Ask before expanding scope or taking an irreversible action.`;
    const chat=store.createChat({folderId:folder?.id,projectId:project.id,model:MODEL,mode:'agent'});
    store.updateChat(chat.id,{title:`Task · ${task.title}`.slice(0,256),draft:prompt});
    let claimed:import('./project-tasks.ts').ProjectTask;
    try{claimed=projectTasks.startTask({projectId:input.projectId,id:input.taskId,revision:input.revision,requestId:input.requestId,chatId:chat.id});}
    catch(error){store.updateChat(chat.id,{archived:true});state();throw error;}
    if(claimed.runChatId!==chat.id){store.updateChat(chat.id,{archived:true});state();const receipt=store.receipt(input.requestId);if(receipt&&claimed.runChatId)return {task:claimed,chatId:claimed.runChatId,runId:receipt.runId};throw new Error('This task start is already being reconciled. Open its linked chat before trying again.');}
    emit({type:'projectChanged',projectId:input.projectId,taskId:input.taskId});state();
    try{const result=await send(chat.id,prompt,input.requestId);return {task:claimed,chatId:chat.id,runId:result.runId};}
    catch(error){
      const receipt=store.receipt(input.requestId);
      if(receipt)return {task:claimed,chatId:chat.id,runId:receipt.runId};
      const reason=error instanceof Error?error.message:'The agent run could not be dispatched.';
      projectTasks.failTaskStart({projectId:input.projectId,id:input.taskId,requestId:input.requestId,chatId:chat.id,reason});
      emit({type:'projectChanged',projectId:input.projectId,taskId:input.taskId});state();throw error;
    }
  }
  async function invoke<K extends keyof Commands>(command: K, input: Commands[K]['input']): Promise<Commands[K]['output']> {
    if (disposed || closing) throw new Error('Agent runtime is stopping or closed.');
    const pending = dispatch(command, input);
    invocations.add(pending);
    try { return await pending as Commands[K]['output']; }
    finally { invocations.delete(pending); }
  }
  async function dispatch(command: string, input: unknown): Promise<unknown> {
    if (command === 'app.snapshot') return snapshot();
    if (command === 'providers.list') {
      const detected = await discoverLocalProviders();
      const runtime = provider.info();
      return [...runtime.map(entry=>({...entry,canReveal:false,source:'Existing local provider profile'})),
        ...detected.filter(entry=>!runtime.some(runnable=>runnable.id===entry.id)).map(({identity,credentialPresent,...entry})=>({...entry,available:false,models:[],canReveal:Boolean(identity),source:'Local configuration discovery',detail:`${entry.detail}. No runnable adapter is enabled for this entry.`})),
        ...customProviders.list()];
    }
    if (command === 'plugins.inventory') return discoverPlugins();
    const p = object(input);
    switch (command) {
      case 'folder.add': { const path = await fs.realpath(text(p.path, 'folder path')); if (!(await fs.stat(path)).isDirectory()) throw new Error('Choose a folder.'); const result = store.addFolder(path, basename(path)); state(); return result; }
      case 'chat.create': { const result = store.createChat({folderId: p.folderId === undefined ? undefined : id(p.folderId), projectId: p.projectId === undefined ? undefined : id(p.projectId), model: MODEL, mode: 'agent'}); state(); return result; }
      case 'chat.select': { const chatId = id(p.id); chatFor(chatId); store.setActiveChat(chatId); return store.timeline(chatId); }
      case 'chat.timeline': {
        const chatId = id(p.id); chatFor(chatId);
        if (p.select !== undefined && typeof p.select !== 'boolean') throw new Error('Invalid selection.');
        if (p.select) store.setActiveChat(chatId);
        return store.timelineSnapshot(chatId);
      }
      case 'chat.update': {
        const chatId = id(p.id); const chat = chatFor(chatId); const patch: Parameters<AgentStore['updateChat']>[1] = {};
        if (p.title !== undefined) { patch.title = text(p.title, 'title', 256).trim(); if (!patch.title) throw new Error('Title cannot be empty.'); }
        if (p.draft !== undefined) patch.draft = text(p.draft, 'draft', 262144);
        for (const flag of ['pinned', 'archived'] as const) if (p[flag] !== undefined) { if (typeof p[flag] !== 'boolean') throw new Error(`Invalid ${flag}.`); patch[flag] = p[flag]; }
        if (p.mode !== undefined) { if (!['ask','plan','agent'].includes(String(p.mode))) throw new Error('Invalid mode.'); if (chat.status === 'running' || chat.status === 'stopping') throw new Error('Stop this run before changing mode.'); patch.mode = p.mode as Chat['mode']; }
        if (p.model !== undefined) { const model = text(p.model, 'model', 256).trim(); if (!model) throw new Error('Choose a model.'); if (providerSelections.has(chatId) || chat.status === 'running' || chat.status === 'stopping' || provider.hasActiveWork?.(chatId)) throw new Error('Stop this run before changing models.'); validateRunnableModel(model,chat.providerId??'hybrow'); patch.model = model; }
        const result = store.updateChat(chatId, patch); state(); return result;
      }
      case 'chat.selectProvider': {
        const chatId=id(p.id),providerId=id(p.providerId),model=text(p.model,'model',256).trim(),chat=chatFor(chatId);
        if (providerSelections.has(chatId) || reconciliations.has(chatId) || runs.has(chatId) || chat.status==='running' || chat.status==='stopping' || provider.hasActiveWork?.(chatId)) throw new Error('Wait for this chat and its background work before changing providers.');
        if (chat.recovery?.kind==='recovery-needed') throw new Error('Resolve the existing provider attempt before switching providers.');
        const selected=validateRunnableModel(model,providerId),bindingId=selected.bindingId??selected.id;
        const changed=(chat.providerId??'hybrow')!==providerId || chat.providerBindingId!==bindingId;
        providerSelections.add(chatId);
        try {
          if (changed) await provider.release?.(chatId);
          if (disposed || closing) throw new Error('Agent runtime is stopping. Provider selection was not changed.');
          const updated=store.updateChat(chatId,{providerId,providerBindingId:bindingId,model,...(changed?{providerThreadId:null,providerTurnId:null,providerThreadProviderId:null,providerThreadBindingId:null,recovery:null,error:null}:{})});
          if(changed && chat.providerThreadId) {store.appendItem(chatId,'notice','Provider selection changed. The next run starts a fresh provider conversation; displayed history is retained.','completed');timeline(chatId);}
          state();return updated;
        } finally {providerSelections.delete(chatId);}
      }
      case 'chat.setPermissionMode': {
        const chatId = id(p.id), chat = chatFor(chatId);
        if (typeof p.permissionMode !== 'string' || !['read-only','workspace','full'].includes(p.permissionMode)) throw new Error('Invalid access policy.');
        if (p.acknowledgeFullAccess !== undefined && typeof p.acknowledgeFullAccess !== 'boolean') throw new Error('Invalid full-access acknowledgement.');
        if (providerSelections.has(chatId) || runs.has(chatId) || chat.status === 'running' || chat.status === 'stopping') throw new Error('Stop this run before changing access.');
        if (p.permissionMode === 'full' && p.acknowledgeFullAccess !== true) throw new Error('Confirm unrestricted filesystem, command execution and network access before selecting Full access.');
        const result = store.updateChat(chatId, {permissionMode:p.permissionMode as NonNullable<Chat['permissionMode']>}); state(); return result;
      }
      case 'chat.movePin': {
        const chatId = id(p.id); chatFor(chatId);
        if (p.direction !== 'up' && p.direction !== 'down') throw new Error('Invalid direction.');
        store.movePin(chatId, p.direction); state(); return;
      }
      case 'chat.send': return send(id(p.id), text(p.text, 'message', 262144), id(p.requestId), p.skillId === undefined ? undefined : text(p.skillId, 'skill id', 4096));
      case 'chat.contextTelemetry': { const chatId = id(p.id); chatFor(chatId); return store.contextTelemetry(chatId); }
      case 'chat.stop': { const chatId = id(p.id); chatFor(chatId); const run = runs.get(chatId); if (!run) return; run.stopped = true; store.updateChat(chatId, {status: 'stopping'}); settleApprovals(chatId); settleQuestions(chatId); state(); await provider.stop(chatId); return; }
      case 'chat.reconcile': {
        const chatId=id(p.id),chat=chatFor(chatId);
        if (runs.has(chatId) || chat.status === 'running' || chat.status === 'stopping') return {chat,resolved:false,reason:'This attempt is still running locally. Stop it or wait before checking recovery.'};
        if (chat.recovery?.kind !== 'recovery-needed') return {chat,resolved:true,reason:'This chat has no unresolved provider attempt.'};
        if (!chat.providerThreadId || !chat.providerTurnId) return {chat,resolved:false,reason:'Muster did not receive the provider turn identity. Automatic verification is unavailable; inspect the existing provider work before continuing.'};
        if (reconciliations.has(chatId)) throw new Error('This chat’s provider status is already being checked.');
        if (reconciliations.size >= 3) throw new Error('Wait for another provider status check to finish.');
        const cwd=chat.folderId ? folderFor(chat.folderId).path : join(options.dataDir,'scratch',chatId);
        reconciliations.add(chatId);
        try {
          const result=await (options.reconcileProvider ?? reconcileProviderTurn)({threadId:chat.providerThreadId,turnId:chat.providerTurnId,cwd,providerId:chat.providerThreadProviderId??chat.providerId??'hybrow',providerBindingId:chat.providerThreadBindingId});
          if (disposed) throw new Error('Agent runtime is closed.');
          const current=chatFor(chatId);
          if (runs.has(chatId) || current.providerThreadId !== chat.providerThreadId || current.providerTurnId !== chat.providerTurnId || current.recovery?.kind !== 'recovery-needed') return {chat:current,resolved:current.recovery?.kind !== 'recovery-needed',reason:'The attempt state changed while checking. Review its current status.'};
          if (!result.resolved || !result.terminalStatus) return {chat:current,resolved:false,reason:result.reason};
          const updated=store.updateChat(chatId,{recovery:null,error:null,status:result.terminalStatus === 'completed' ? 'completed' : result.terminalStatus === 'interrupted' ? 'interrupted' : 'failed'});
          store.appendItem(chatId,'notice',result.reason,'completed',{providerThreadId:chat.providerThreadId,providerTurnId:chat.providerTurnId,reconciledStatus:result.terminalStatus});
          timeline(chatId);state();return {chat:updated,resolved:true,reason:result.reason};
        } finally {reconciliations.delete(chatId);}
      }
      case 'approval.respond': { const approvalId = id(p.id); if (typeof p.approved !== 'boolean') throw new Error('Invalid approval decision.'); const pending = approvals.get(approvalId); if (!pending) throw new Error('This approval is no longer pending.'); finishApproval(approvalId, pending, p.approved, p.approved ? 'approved' : 'declined'); return; }
      case 'question.respond': {
        const questionId = id(p.id); const pending = questions.get(questionId); if (!pending) throw new Error('This question is no longer pending.');
        if (!p.answers || typeof p.answers !== 'object' || Array.isArray(p.answers)) throw new Error('Invalid question answers.');
        const answers: Record<string, {answers: string[]}> = Object.create(null) as Record<string, {answers: string[]}>;
        const suppliedKeys = Object.getOwnPropertyNames(p.answers as object);
        if (suppliedKeys.some(key => !pending.questions.some(question => question.id === key))) throw new Error('Invalid question answers.');
        for (const question of pending.questions) {
          const answer = (p.answers as Record<string, unknown>)[question.id];
          const values = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Record<string, unknown>).answers : undefined;
          if (!Array.isArray(values) || values.length === 0 || values.length > 16 || values.some(value => typeof value !== 'string' || value.trim().length === 0 || value.length > 4096)) throw new Error('Invalid question answers.');
          if (!question.multiSelect && values.length !== 1) throw new Error('This question accepts one answer.');
          if (!question.allowCustomAnswer && values.some(value => !question.options.some(option => (option.value ?? option.label) === value))) throw new Error('Custom answers are not allowed for this question.');
          answers[question.id] = { answers: values.map(value => question.isSecret ? value : value.trim()) };
        }
        const receiptAnswers: Record<string, {answers: string[]}> = Object.create(null) as Record<string, {answers: string[]}>;
        for (const question of pending.questions) receiptAnswers[question.id] = question.isSecret ? {answers: ['[redacted]']} : answers[question.id];
        finishQuestion(questionId, pending, {...answers}, 'answered', receiptAnswers); return;
      }
      case 'project.create': { const name = text(p.name,'project name',256).trim(); if (!name) throw new Error('Name the Project.'); if (!Array.isArray(p.folderIds) || p.folderIds.length > 100) throw new Error('Invalid Project folders.'); const result = store.createProject(name, text(p.goal,'goal',32768), [...new Set(p.folderIds.map(id))]); state(); return result; }
      case 'project.tasks.list': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); return projectTasks.listTasks(projectId); }
      case 'project.tasks.create': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); if(!Array.isArray(p.dependencies)||p.dependencies.length>50) throw new Error('Invalid dependencies.'); return projectTasks.createTask({projectId,title:text(p.title,'task title',500),acceptance:text(p.acceptance,'acceptance criteria',4000),dependencies:[...new Set(p.dependencies.map(id))]}); }
      case 'project.tasks.start': return startProjectTask({projectId:id(p.projectId),id:id(p.id),revision:Number(p.revision),requestId:id(p.requestId),...(p.folderId===undefined?{}:{folderId:id(p.folderId)})});
      case 'project.tasks.updateStatus': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); const taskId=id(p.id); if(!['todo','running','blocked','implemented','verified'].includes(String(p.status))) throw new Error('Invalid task status.'); if(!Number.isSafeInteger(p.revision)||Number(p.revision)<0) throw new Error('Invalid revision.'); const evidence=p.evidence===undefined?undefined:Array.isArray(p.evidence)&&p.evidence.length<=50?p.evidence.map(e=>text(e,'evidence',2000)):(()=>{throw new Error('Invalid evidence.');})(); return projectTasks.updateTaskStatus({projectId,id:taskId,status:p.status as TaskStatus,evidence,revision:Number(p.revision)}); }
      case 'project.tasks.addEvidence': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); if(!Array.isArray(p.entries)||p.entries.length<1||p.entries.length>50) throw new Error('Provide 1–50 evidence entries.'); if(!Number.isSafeInteger(p.revision)||Number(p.revision)<0) throw new Error('Invalid revision.'); return projectTasks.addEvidence({projectId,id:id(p.id),entries:p.entries.map(e=>text(e,'evidence',2000)),revision:Number(p.revision)}); }
      case 'project.decisions.list': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); return projectTasks.listDecisions(projectId); }
      case 'project.decisions.create': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); if(!Array.isArray(p.relatedTaskIds)||p.relatedTaskIds.length>50) throw new Error('Invalid related tasks.'); return projectTasks.createDecision({projectId,title:text(p.title,'decision title',500),rationale:text(p.rationale,'rationale',8000),scope:text(p.scope,'scope',500),relatedTaskIds:[...new Set(p.relatedTaskIds.map(id))]}); }
      case 'project.decisions.supersede': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); return projectTasks.supersedeDecision({projectId,id:id(p.id),replacementId:id(p.replacementId)}); }
      case 'project.activity.list': { const projectId=id(p.projectId); if(!store.project(projectId)) throw new Error('Project not found.'); const limit=p.limit===undefined?100:Number(p.limit); if(!Number.isSafeInteger(limit)||limit<1||limit>200) throw new Error('Invalid limit.'); return projectTasks.listActivity(projectId,limit); }
      case 'project.export': { const projectId=id(p.projectId), project=store.project(projectId); if(!project) throw new Error('Project not found.'); const folders=project.folderIds.map(folderId=>store.folder(folderId)).filter((folder):folder is NonNullable<typeof folder>=>Boolean(folder)); const chats=store.projectChats(projectId).map(({id,title,folderId,providerId,model,mode,permissionMode,status,updatedAt,recovery})=>({id,title,...(folderId?{folderId}:{}),providerId:providerId??'hybrow',model,mode,...(permissionMode?{permissionMode}:{}),status,updatedAt,...(recovery?{recovery}:{} )})); return projectTasks.exportProject(project,folders,chats); }
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
      case 'files.create': {
        const folder = folderFor(p.folderId);
        if (p.kind !== 'file' && p.kind !== 'directory') throw new Error('Invalid file type.');
        await createEntry(folder.path, text(p.path, 'path'), p.kind);
        emit({type:'workspaceChanged',folderId:folder.id}); return;
      }
      case 'files.move': {
        const folder = folderFor(p.folderId), from = text(p.from, 'source'), to = text(p.to, 'destination');
        await moveFile(folder.path, from, to);
        try { annotations.move(folder.id, from, to); }
        catch { emit({type:'notice',message:'File moved. Its notes remain associated with the original path.'}); }
        emit({type:'fileMoved',folderId:folder.id,from,to});
        emit({type:'workspaceChanged',folderId:folder.id}); return;
      }
      case 'files.search': return searchFiles(folderFor(p.folderId).path, text(p.path ?? '', 'path'), text(p.query,'query',256));
      case 'files.read': return readFile(folderFor(p.folderId).path, text(p.path,'path'));
      case 'files.document': return readDocument(folderFor(p.folderId).path,text(p.path,'path'));
      case 'files.workbook': return readWorkbook(folderFor(p.folderId).path,text(p.path,'path'));
      case 'files.annotations.list':
      case 'files.annotations.add':
      case 'files.annotations.remove': {
        const folder=folderFor(p.folderId),path=text(p.path,'path');
        await resolveInside(folder.path,path);
        if(command==='files.annotations.list')return annotations.list(folder.id,path);
        if(command==='files.annotations.remove')return annotations.remove(folder.id,path,id(p.id));
        return annotations.add({folderId:folder.id,path,revision:text(p.revision,'revision',64),location:text(p.location,'location',256),quote:text(p.quote,'quote',2000),note:text(p.note,'note',4000)});
      }
      case 'files.asset': return readAsset(folderFor(p.folderId).path, text(p.path,'path'));
      case 'git.changes': { const root = folderFor(p.folderId).path; const result = await new AgentModeReviewHost(() => root).listChanges(); if (result.error) throw new Error(result.error); return result.files; }
      case 'git.status': return gitStatus(folderFor(p.folderId).path);
      case 'git.mutate': {
        if (!['stage','unstage','commit'].includes(String(p.operation))) throw new Error('Invalid Git operation.');
        const folder = folderFor(p.folderId);
        const result = await mutateGit(folder.path, p.operation as 'stage'|'unstage'|'commit', text(p.revision,'revision',64), p.paths, p.message === undefined ? undefined : text(p.message,'message',32768));
        emit({type:'workspaceChanged',folderId:folder.id}); return result;
      }
      case 'git.diff': { const root = folderFor(p.folderId).path; const result = await new AgentModeReviewHost(() => root).readChange(text(p.path,'path')); if (result.error) throw new Error(result.error); return {path: result.path, before: result.before, after: result.after, truncated: result.truncated}; }
      case 'providers.save': return customProviders.save({id:p.id,name:p.name,endpoint:p.endpoint,apiKeyEnv:p.apiKeyEnv});
      case 'providers.cancelCheck': customProviders.cancel(id(p.id)); return;
      case 'providers.remove': { const key=id(p.id); if(!key.startsWith('custom_')) throw new Error('Discovered connections are managed in their original app.'); customProviders.remove(key); return; }
      case 'providers.check': return customProviders.check(id(p.id));
      case 'providers.reveal': { const key=id(p.id); const info=(await discoverLocalProviders()).find(row=>row.id===key); if(!info?.identity) throw new Error('This connection has no account label to reveal.'); return {identity:info.identity}; }
      case 'memory.list': { const context = memoryContext(p.folderId); const objects = await listMemory(context.cwd); return objects.filter(object => isVisibleInScopes(object, context.scopes)); }
      case 'memory.search': { const context = memoryContext(p.folderId); const q = text(p.query,'query',256); const limit = typeof p.limit==='number' && Number.isFinite(p.limit) ? Math.min(200,Math.max(1,Math.floor(p.limit))) : 50; return searchMemory({query:q,limit,scopes:context.scopes},context.cwd); }
      case 'memory.add': { const context = memoryContext(p.folderId); const summary = text(p.summary,'summary',8192); const kind = typeof p.kind==='string' ? text(p.kind,'kind',64) : 'fact'; if (!Array.isArray(p.provenance) || p.provenance.length < 1 || p.provenance.length > 16) throw new Error('Supply between 1 and 16 provenance entries.'); const provenance = (p.provenance as unknown[]).map(v=>text(v,'provenance item',256)); const scopes = requestedMemoryScopes(p.scopes, context.scopes); try { const result = await addMemory({summary,kind,provenance,scopes,explicitUserRequest:true},context.cwd); return result; } catch(e) { if(e instanceof Error && e.name === 'MemoryPolicyError') throw new Error(`Memory policy (${String((e as {policy?: unknown}).policy)}): ${e.message}`); throw e; } }
      case 'memory.inspect': { const context = memoryContext(p.folderId); try { const r = await inspectMemoryStore(context.cwd); return {available:true,objectCount:r.jsonl.objectCount,checks:r.checks}; } catch(e) { return {available:false,objectCount:0,checks:[],error:e instanceof Error?e.message:String(e)}; } }
      case 'hindsight.status': return hindsightClient().status(p.folderId === undefined ? 'personal' : id(p.folderId));
      case 'hindsight.retain': return hindsightClient().retain({folderId: p.folderId === undefined ? 'personal' : id(p.folderId), items: [{content: text(p.content, 'content', 32768)}], provenance: [text(p.source, 'source', 512)], async: false});
      case 'hindsight.recall': return hindsightClient().recall({folderId: p.folderId === undefined ? 'personal' : id(p.folderId), query: text(p.query, 'query', 8192), budget: p.budget as 'low'|'mid'|'high'|undefined ?? 'low', maxTokens: typeof p.maxTokens === 'number' ? p.maxTokens : 2048, types: p.types as ('world'|'experience'|'observation')[]|undefined, tags: p.tags as string[]|undefined});
      case 'hindsight.reflect': return hindsightClient().reflect({folderId: p.folderId === undefined ? 'personal' : id(p.folderId), query: text(p.query, 'query', 8192), context: p.context === undefined ? undefined : text(p.context, 'context', 32768), budget: p.budget as 'low'|'mid'|'high'|undefined ?? 'low', maxTokens: typeof p.maxTokens === 'number' ? p.maxTokens : 2048});
      case 'plugins.list': {
        const allowedFolders = new Set(store.snapshot().folders.map(folder => folder.path));
        const folderPaths = Array.isArray(p.folderPaths)
          ? (p.folderPaths as unknown[]).filter((value): value is string => typeof value === 'string' && value.length <= 4096)
            .filter(value => allowedFolders.has(value))
          : [];
        return discoverSkills(folderPaths);
      }
      default: throw new Error('Unsupported command.');
    }
  }
  return {invoke, dispose(): Promise<void> {
    if (disposal) return disposal;
    closing = true;
    disposal = (async () => {
      watcher.dispose(); watchedFolders.clear();
      for (const [chatId, run] of runs) { run.stopped = true; settleApprovals(chatId); settleQuestions(chatId); }
      provider.dispose();
      // Main owns the user-visible deadline. Keep the database open until all
      // tracked callbacks settle, even if main times out and keeps the app open.
      hindsight?.dispose();
      await Promise.allSettled([...invocations,...[...runs.values()].flatMap(run => run.promise ? [run.promise] : [])]);
      disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); customProviders.close(); annotations.close(); projectTasks.close(); store.close();
    })();
    return disposal;
  }};
}
