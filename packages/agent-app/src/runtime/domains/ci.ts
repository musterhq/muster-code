import {randomUUID} from 'node:crypto';
import type {Folder} from '../../shared/protocol.ts';
import {CI_REPAIR_DEFAULT_ATTEMPTS, CI_REPAIR_MAX_ATTEMPTS, ciRepairActive, type CiRepair} from '../../shared/domains/ci-protocol.ts';
import {abortableSleep, checkLog, REPAIR_TIMING, runRepairLoop, type RepairTiming} from '../github-ci.ts';
import {getPullRequest, listChecks} from '../github.ts';
import {gitStatus} from '../git-local.ts';
import type {DomainContext, DomainModule} from './types.ts';

/** Test seam: shorten the repair loop's polling and timeouts. */
export const ciRepairTiming: RepairTiming = {...REPAIR_TIMING};
const KEEP = 20;
const busy = (status: string | undefined) => status === 'running' || status === 'stopping';

/**
 * CI domain (GIT-08): log excerpts for failing checks and the bounded "Fix failing checks" task. A repair
 * runs its agent turns in one chat (the caller's idle chat in that folder, or a new one), follows each turn
 * to its settle through the onRunSettled hook, and streams its state as `ciRepair` events so the summary
 * card and the PR tab show the same progress. Stop aborts the loop and stops the turn it is waiting on.
 */
export function createCiDomain(context: DomainContext): DomainModule {
  const folder = (value: unknown): Folder => {
    if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Choose a folder.');
    return context.folderFor(value);
  };
  const prNumber = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('Choose a pull request.');
    return value;
  };
  const repairs = new Map<string, {state: CiRepair; controller: AbortController}>();
  /** Turns the loop is waiting on, and turns that settled before the loop started waiting (bounded). */
  const waiting = new Map<string, (status: string) => void>();
  const settledEarly = new Map<string, string>();
  const offSettled = context.hooks.onRunSettled(run => {
    const resolve = waiting.get(run.runId);
    if (resolve) { waiting.delete(run.runId); resolve(run.status); return; }
    settledEarly.set(run.runId, run.status);
    if (settledEarly.size > 50) settledEarly.delete(settledEarly.keys().next().value!);
  });
  const waitFor = (runId: string, signal: AbortSignal): Promise<string> => {
    const early = settledEarly.get(runId);
    if (early) { settledEarly.delete(runId); return Promise.resolve(early); }
    return new Promise(resolve => {
      const done = (status: string) => { signal.removeEventListener('abort', abort); resolve(status); };
      // After a Stop the turn still settles (interrupted); wait for that, but never forever.
      const abort = () => { setTimeout(() => { if (waiting.get(runId) === done) { waiting.delete(runId); resolve('interrupted'); } }, 5_000).unref?.(); };
      waiting.set(runId, done);
      signal.addEventListener('abort', abort, {once: true});
    });
  };
  const publish = (state: CiRepair) => { try { context.emit({type: 'ciRepair', repair: state}); } catch { /* the renderer re-reads with ci.repair.list */ } };
  const trim = () => {
    const done = [...repairs.values()].filter(entry => !ciRepairActive(entry.state));
    for (const entry of done.slice(0, Math.max(0, repairs.size - KEEP))) repairs.delete(entry.state.id);
  };

  return {
    handlers: {
      'ci.checkLog': input => checkLog(folder(input.folderId).path, prNumber(input.number), input.checkId, input.refresh === true),
      'ci.repair.start': async input => {
        const target = folder(input.folderId), number = prNumber(input.number);
        for (const entry of repairs.values()) if (entry.state.folderId === target.id && entry.state.number === number && ciRepairActive(entry.state)) throw new Error(`A repair is already running for #${number}. Stop it first.`);
        const requested = input.maxAttempts === undefined ? CI_REPAIR_DEFAULT_ATTEMPTS : Number(input.maxAttempts);
        if (!Number.isInteger(requested) || requested < 1 || requested > CI_REPAIR_MAX_ATTEMPTS) throw new Error(`Choose between 1 and ${CI_REPAIR_MAX_ATTEMPTS} attempts.`);
        const pr = await getPullRequest(target.path, number, true);
        if (pr.state !== 'open') throw new Error(`#${number} is ${pr.state}; only open pull requests can be repaired.`);
        // The agent commits in this folder, so it has to be on the PR's branch.
        const local = await gitStatus(target.path);
        if (local.detached || local.branch !== pr.headRef) throw new Error(`Check out ${pr.headRef} in ${target.name} first (it is on ${local.detached ? 'a detached HEAD' : local.branch ?? 'no branch'}).`);
        let chatId: string | undefined;
        if (typeof input.chatId === 'string') {
          const chat = context.store.chat(input.chatId);
          if (chat && !chat.archived && chat.folderId === target.id && !busy(chat.status)) chatId = chat.id;
        }
        const state: CiRepair = {id: randomUUID(), folderId: target.id, number, headRef: pr.headRef, ...(chatId ? {chatId} : {}), maxAttempts: requested,
          phase: 'checking', message: 'Reading the latest checks…', headSha: pr.headSha, attempts: [], startedAt: new Date().toISOString()};
        const controller = new AbortController();
        repairs.set(state.id, {state, controller});
        trim();
        publish({...state, attempts: []});
        void runRepairLoop(state, {
          checks: refresh => listChecks(target.path, number, refresh),
          logs: async failing => (await Promise.all(failing.slice(0, 6).map(check => checkLog(target.path, number, check.id).catch(() => null)))).filter(log => log !== null),
          runAgent: async (prompt, attempt) => {
            if (!state.chatId) {
              const chat = await context.invoke('chat.create', {folderId: target.id});
              await context.invoke('chat.update', {id: chat.id, title: `Fix checks · #${number}`, mode: 'agent'});
              state.chatId = chat.id;
            }
            context.store.appendItem(state.chatId, 'notice', `Fix failing checks · #${number} · attempt ${attempt} of ${state.maxAttempts}`, 'completed', {kind: 'ci-repair', repairId: state.id, attempt});
            const sent = await context.invoke('chat.send', {id: state.chatId, text: prompt, requestId: `ci-repair-${state.id}-${attempt}`});
            return {runId: sent.runId, status: await waitFor(sent.runId, controller.signal)};
          },
          sleep: abortableSleep,
          now: () => Date.now(),
          emit: publish,
        }, controller.signal, ciRepairTiming);
        return {...state, attempts: []};
      },
      'ci.repair.stop': async input => {
        const entry = typeof input.id === 'string' ? repairs.get(input.id) : undefined;
        if (!entry) throw new Error('That repair is no longer running.');
        if (!ciRepairActive(entry.state)) return entry.state;
        entry.controller.abort();
        const chat = entry.state.chatId ? context.store.chat(entry.state.chatId) : undefined;
        if (chat && busy(chat.status)) await context.invoke('chat.stop', {id: chat.id}).catch(() => undefined);
        return {...entry.state, attempts: entry.state.attempts.map(attempt => ({...attempt}))};
      },
      'ci.repair.list': input => [...repairs.values()].map(entry => entry.state)
        .filter(state => typeof input.folderId !== 'string' || state.folderId === input.folderId)
        .map(state => ({...state, attempts: state.attempts.map(attempt => ({...attempt}))})),
    },
    dispose() {
      offSettled();
      for (const entry of repairs.values()) entry.controller.abort();
      for (const resolve of waiting.values()) resolve('interrupted');
      waiting.clear();
    },
  };
}
