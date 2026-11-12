/**
 * Compare runs (#175): one prompt sent to two to four provider/model pairs. Each pair gets a new chat in its own git
 * worktree on its own branch, all starting at the current commit of the folder's branch, so the runs never touch each
 * other or the original checkout. The compare view reads each run's changes against that start commit through the
 * review domain; "Use this one" merges the winner's branch into the original branch (a conflict is left to the existing
 * conflict view), then archives the other runs and removes every worktree. A run's unmerged work is only thrown away
 * when the user chose to discard it; otherwise it is committed on its branch, which is kept.
 *
 * Groups live in the runtime's SQLite store, so they survive a restart.
 */
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {ChatAttachments} from '../attachments.ts';
import {gitRepository, runGit, serial} from '../git-local.ts';
import {conflictState} from '../git-conflicts.ts';
import {MAX_ATTACHMENTS_PER_MESSAGE, REASONING_EFFORTS, type Chat, type ReasoningEffort} from '../../shared/protocol.ts';
import {COMPARE_MAX_RUNS, COMPARE_MIN_RUNS, type CompareChoice, type CompareCi, type CompareOutcome, type ComparePickResult, type CompareRunDetail, type CompareTarget, type CompareTestRun, type Comparison, type ComparisonDetail, type ComparisonRun, type ComparisonState} from '../../shared/domains/compare-protocol.ts';
import type {DomainContext, DomainModule} from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY, request_id TEXT UNIQUE, folder_id TEXT NOT NULL, source_chat_id TEXT NOT NULL,
  base_branch TEXT NOT NULL, base_sha TEXT NOT NULL, prompt TEXT NOT NULL, created_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open', winner_chat_id TEXT, choices TEXT);
CREATE TABLE IF NOT EXISTS comparison_runs (
  comparison_id TEXT NOT NULL, ordinal INTEGER NOT NULL, chat_id TEXT NOT NULL UNIQUE, folder_id TEXT NOT NULL,
  branch TEXT NOT NULL, worktree_path TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
  started_at TEXT, settled_at TEXT, outcome TEXT, PRIMARY KEY (comparison_id, ordinal));`;
interface GroupRow {id: string; request_id: string | null; folder_id: string; source_chat_id: string; base_branch: string; base_sha: string; prompt: string; created_at: string; state: string; winner_chat_id: string | null; choices: string | null}
interface RunRow {comparison_id: string; ordinal: number; chat_id: string; folder_id: string; branch: string; worktree_path: string; provider_id: string; model: string; started_at: string | null; settled_at: string | null; outcome: string | null}

/** Commands whose name says it runs a test suite: `npm test`, `pnpm run test:unit`, `pytest`, `cargo test`, `go test ./...`, `vitest`… */
const TEST_COMMAND = /(^|[\s;&|/(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test[\w:-]*|pytest|py\.test|vitest|jest|mocha|(?:cargo|go|deno|swift|dotnet|mix)\s+test|node\s+--test|rspec|phpunit|tox|gradle(?:w)?\s+test|mvn\s+test|make\s+test|ctest)\b/;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const idOf = (value: unknown, label: string): string => { if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Choose ${label}.`); return value; };
const slug = (value: string, max: number) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const busy = (chat: Pick<Chat, 'status'> | undefined) => chat?.status === 'running' || chat?.status === 'stopping';
const exists = (path: string) => fs.stat(path).then(() => true, () => false);

export function createCompareDomain(context: DomainContext): DomainModule {
  let ready = false;
  const db = () => { const handle = context.db(); if (!ready) { handle.exec(SCHEMA); ready = true; } return handle; };
  let files: ChatAttachments | undefined;
  const attachments = () => files ??= new ChatAttachments(context.db(), context.dataDir);

  const runsOf = (id: string) => db().prepare('SELECT * FROM comparison_runs WHERE comparison_id = ? ORDER BY ordinal').all(id) as unknown as RunRow[];
  const toRun = (row: RunRow): ComparisonRun => ({chatId: row.chat_id, folderId: row.folder_id, branch: row.branch, worktreePath: row.worktree_path, providerId: row.provider_id, model: row.model,
    startedAt: row.started_at, settledAt: row.settled_at, ...(row.outcome ? {outcome: row.outcome as CompareOutcome} : {})});
  const stateOf = (row: GroupRow, runs: readonly RunRow[]): ComparisonState => {
    if (row.state === 'merging' || row.state === 'merged') return row.state;
    return runs.some(run => busy(context.store.chat(run.chat_id))) ? 'running' : 'ready';
  };
  const toComparison = (row: GroupRow): Comparison => {
    const runs = runsOf(row.id);
    return {id: row.id, folderId: row.folder_id, sourceChatId: row.source_chat_id, baseBranch: row.base_branch, baseSha: row.base_sha, prompt: row.prompt, createdAt: row.created_at,
      state: stateOf(row, runs), winnerChatId: row.winner_chat_id, runs: runs.map(toRun)};
  };
  const groupRow = (id: unknown): GroupRow => {
    const row = db().prepare('SELECT * FROM comparisons WHERE id = ?').get(idOf(id, 'a comparison')) as GroupRow | undefined;
    if (!row) throw new Error('That comparison no longer exists.');
    return row;
  };
  const groupOfChat = (chatId: string) => db().prepare('SELECT comparison_id FROM comparison_runs WHERE chat_id = ?').get(chatId) as {comparison_id: string} | undefined;
  const announce = (id: string) => { try { context.emit({type: 'comparison', comparison: toComparison(groupRow(id))}); } catch { /* removed meanwhile */ } };

  // Time each run takes: from its chat's first start to its latest settle.
  const offStart = context.hooks.onRunStarted(({chat}) => {
    const group = groupOfChat(chat.id); if (!group) return;
    db().prepare('UPDATE comparison_runs SET started_at = COALESCE(started_at, ?), settled_at = NULL WHERE chat_id = ?').run(new Date().toISOString(), chat.id);
    announce(group.comparison_id);
  });
  const offSettle = context.hooks.onRunSettled(({chat}) => {
    const group = groupOfChat(chat.id); if (!group) return;
    db().prepare('UPDATE comparison_runs SET settled_at = ? WHERE chat_id = ?').run(new Date().toISOString(), chat.id);
    // The chat's status is written after this hook; tell the renderer once it is.
    setTimeout(() => announce(group.comparison_id), 0);
  });

  /** A run has work when its worktree has changes or its branch has commits past the start commit. */
  const hasWork = async (repo: string, baseSha: string, run: RunRow): Promise<boolean> => {
    if (await exists(run.worktree_path)) {
      const status = await runGit(run.worktree_path, ['status', '--porcelain', '--untracked-files=all']).catch(() => '');
      if (status.trim()) return true;
    }
    const ahead = await runGit(repo, ['rev-list', '--count', `${baseSha}..refs/heads/${run.branch}`]).catch(() => '0');
    return Number(ahead.trim()) > 0;
  };
  /** Commits whatever the run left uncommitted in its worktree onto its branch. */
  const commitWork = async (run: RunRow, message: string) => {
    if (!await exists(run.worktree_path)) return;
    const status = await runGit(run.worktree_path, ['status', '--porcelain', '--untracked-files=all']);
    if (!status.trim()) return;
    await runGit(run.worktree_path, ['add', '-A'], 60000);
    await runGit(run.worktree_path, ['commit', '-q', '-m', message], 60000);
  };
  const branchExists = (repo: string, branch: string) => runGit(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  const removeWorktree = async (repo: string, run: RunRow, force: boolean) => {
    if (await exists(run.worktree_path)) await runGit(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), run.worktree_path], 60000);
    await runGit(repo, ['worktree', 'prune']).catch(() => '');
  };
  const forgetFolder = async (folderId: string) => {
    if (!context.store.folder(folderId)) return;
    await context.invoke('folder.remove', {id: folderId, archiveChats: false}).catch(() => undefined);
  };
  const titleOf = (run: RunRow) => context.store.chat(run.chat_id)?.title ?? run.model;

  const repoOf = async (folderId: string): Promise<string> => {
    const folder = context.folderFor(folderId);
    const inside = await runGit(folder.path, ['rev-parse', '--is-inside-work-tree']).then(out => out.trim() === 'true', () => false);
    if (!inside) throw new Error(`${folder.name} is not a Git repository, so the runs can’t each get their own copy of it. Send to several needs a Git repository.`);
    return gitRepository(folder.path);
  };

  const testRuns = (chatId: string): CompareTestRun[] => context.store.commandItems(chatId).flatMap(item => {
    const command = typeof item.data?.command === 'string' ? item.data.command : typeof item.data?.name === 'string' ? item.data.name : firstLine(item.text);
    if (!TEST_COMMAND.test(command)) return [];
    const exitCode = typeof item.data?.exitCode === 'number' ? item.data.exitCode : null;
    const status: CompareTestRun['status'] = item.status === 'running' ? 'running' : item.status === 'completed' && (exitCode === null || exitCode === 0) ? 'passed' : 'failed';
    return [{command: clip(command, 200), status, exitCode}];
  }).slice(-5);

  const ciOf = async (folderId: string): Promise<CompareCi | null> => {
    try {
      const repairs = await context.invoke('ci.repair.list', {folderId});
      const latest = repairs.at(-1);
      return latest?.checks ? {passed: latest.checks.passed, failed: latest.checks.failed, pending: latest.checks.pending, message: latest.message} : null;
    } catch { return null; }
  };

  const detailOf = async (group: GroupRow, run: RunRow): Promise<CompareRunDetail> => {
    const chat = context.store.chat(run.chat_id);
    const started = run.started_at ? Date.parse(run.started_at) : NaN, settled = run.settled_at ? Date.parse(run.settled_at) : NaN;
    const durationMs = Number.isFinite(started) ? Math.max(0, (Number.isFinite(settled) ? settled : busy(chat) ? Date.now() : NaN) - started) : NaN;
    let tokens: number | null = null, costUsd: number | null = null;
    try {
      const usage = await context.invoke('models.usage.chat', {chatId: run.chat_id});
      if (usage.rows.length) { tokens = usage.totals.inputTokens + usage.totals.outputTokens; costUsd = usage.costUsd; }
    } catch { /* no usage reported */ }
    const base: CompareRunDetail = {chatId: run.chat_id, title: chat?.title ?? run.model, status: chat?.status ?? 'idle', archived: chat?.archived ?? true,
      providerId: run.provider_id, model: run.model, branch: run.branch, folderId: run.folder_id, durationMs: Number.isFinite(durationMs) ? durationMs : null,
      tokens, costUsd, reply: context.store.lastAssistantItem(run.chat_id)?.text ?? null,
      files: [], adds: 0, dels: 0, truncated: false, tests: testRuns(run.chat_id), ci: null, hasWork: false};
    if (!context.store.folder(run.folder_id) || !await exists(run.worktree_path)) {
      // After a pick the worktree is gone: what the branch holds against the start commit is still worth showing.
      return {...base, ...(run.outcome ? {} : {error: 'This run’s worktree is gone.'})};
    }
    const repo = context.folderFor(group.folder_id).path;
    const [changes, work, ci] = await Promise.all([
      context.invoke('review.changes', {folderId: run.folder_id, baseline: {ref: group.base_sha}}).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))),
      hasWork(repo, group.base_sha, run), ciOf(run.folder_id),
    ]);
    if (changes instanceof Error) return {...base, hasWork: work, ci, error: changes.message};
    return {...base, files: changes.files, truncated: changes.truncated, adds: changes.files.reduce((sum, file) => sum + file.adds, 0), dels: changes.files.reduce((sum, file) => sum + file.dels, 0), hasWork: work, ci};
  };

  const validTargets = (value: unknown): CompareTarget[] => {
    if (!Array.isArray(value) || value.length < COMPARE_MIN_RUNS || value.length > COMPARE_MAX_RUNS) throw new Error(`Pick two to four models to send to.`);
    const seen = new Set<string>();
    return value.map(entry => {
      const target = entry as Partial<CompareTarget> | null;
      if (!target || typeof target.providerId !== 'string' || typeof target.model !== 'string' || !target.providerId || !target.model || target.providerId.length > 128 || target.model.length > 256) throw new Error('Choose a provider and model for each run.');
      const key = `${target.providerId}\0${target.model}`;
      if (seen.has(key)) throw new Error(`${target.model} is picked twice. Pick each model once.`);
      seen.add(key);
      return {providerId: target.providerId, model: target.model};
    });
  };
  const modelName = (target: CompareTarget) => context.modelCatalog?.().providers.find(entry => entry.id === target.providerId)?.models.find(model => model.id === target.model)?.name ?? target.model;

  return {handlers: {
    'compare.start': async input => {
      const sourceId = idOf(input.chatId, 'a chat'), requestId = idOf(input.requestId, 'a request');
      const text = typeof input.text === 'string' ? input.text : '';
      if (text.length > 262144) throw new Error('This message is too long.');
      const targets = validTargets(input.targets);
      const attachmentIds = input.attachmentIds === undefined ? [] : Array.isArray(input.attachmentIds) && input.attachmentIds.length <= MAX_ATTACHMENTS_PER_MESSAGE ? input.attachmentIds.map(value => idOf(value, 'an attachment')) : (() => { throw new Error(`Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`); })();
      if (!text.trim() && !attachmentIds.length) throw new Error('Write something to send first.');
      const effort = input.effort === undefined ? undefined : (REASONING_EFFORTS as readonly unknown[]).includes(input.effort) ? input.effort as ReasoningEffort : (() => { throw new Error('Choose a reasoning effort.'); })();
      const list = (value: unknown) => value === undefined ? undefined : Array.isArray(value) && value.length <= 8 && value.every(entry => typeof entry === 'string') ? value as string[] : (() => { throw new Error('Attach at most 8 skills or plugins.'); })();
      const skillIds = list(input.skillIds), pluginIds = list(input.pluginIds);
      const replay = db().prepare('SELECT * FROM comparisons WHERE request_id = ?').get(requestId) as GroupRow | undefined;
      if (replay) return toComparison(replay);

      const source = context.store.chat(sourceId);
      if (!source) throw new Error('That chat no longer exists.');
      if (!source.folderId) throw new Error('Send to several needs a folder: open a chat in a Git repository first.');
      const repo = await repoOf(source.folderId);
      const baseBranch = (await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
      if (!baseBranch) throw new Error('Check out a branch first: the run you pick is merged back into it.');
      const baseSha = (await runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim();
      if (!baseSha) throw new Error('Make a first commit before sending to several models.');
      const catalog = context.modelCatalog?.().providers;
      if (catalog) for (const target of targets) {
        const provider = catalog.find(entry => entry.id === target.providerId);
        if (!provider?.available || !provider.models.some(model => model.id === target.model)) throw new Error(`${target.model} on ${provider?.name ?? target.providerId} isn’t available. Pick another model.`);
      }
      // The staged files are read once and staged again into each run's chat.
      const payload: {name: string; mime: string; data: string}[] = [];
      if (attachmentIds.length) {
        const refs = await context.invoke('attachments.info', {chatId: sourceId, ids: attachmentIds});
        if (refs.length !== attachmentIds.length) throw new Error('An attached file is no longer available. Remove it and try again.');
        for (const ref of refs) {
          const location = attachments().location(sourceId, ref.id);
          if (!location) throw new Error('An attached file is no longer available. Remove it and try again.');
          payload.push({name: ref.name, mime: ref.mime, data: (await fs.readFile(join(location.root, location.rel))).toString('base64')});
        }
      }

      const id = randomUUID(), short = id.slice(0, 6), topic = slug(firstLine(text), 24) || 'run';
      const created: {chatId?: string; folderId?: string; path?: string; branch?: string}[] = [];
      const rows: RunRow[] = [];
      try {
        for (const [ordinal, target] of targets.entries()) {
          const entry: (typeof created)[number] = {}; created.push(entry);
          const branch = `muster/compare-${topic}-${short}-${ordinal + 1}-${slug(target.model, 20) || 'model'}`;
          const worktree = await context.invoke('git.worktree.create', {folderId: source.folderId, branch, base: baseSha});
          Object.assign(entry, {folderId: worktree.folder.id, path: worktree.path, branch: worktree.branch});
          const chat = await context.invoke('chat.create', {folderId: worktree.folder.id, inheritFrom: sourceId});
          entry.chatId = chat.id;
          if (chat.providerId !== target.providerId || chat.model !== target.model) await context.invoke('chat.selectProvider', {id: chat.id, providerId: target.providerId, model: target.model});
          await context.invoke('chat.update', {id: chat.id, title: clip(`${clip(firstLine(text) || source.title, 60)} · ${modelName(target)}`, 120)});
          rows.push({comparison_id: id, ordinal, chat_id: chat.id, folder_id: worktree.folder.id, branch: worktree.branch, worktree_path: worktree.path, provider_id: target.providerId, model: target.model, started_at: null, settled_at: null, outcome: null});
        }
      } catch (error) {
        // All or nothing: undo the chats, folders, worktrees and branches made so far (they hold no work yet).
        for (const entry of created.reverse()) {
          if (entry.chatId) await context.invoke('chat.delete', {id: entry.chatId, force: true}).catch(() => undefined);
          if (entry.folderId) await forgetFolder(entry.folderId);
          if (entry.path) await runGit(repo, ['worktree', 'remove', '--force', entry.path], 60000).catch(() => '');
          if (entry.branch) await runGit(repo, ['branch', '-D', entry.branch]).catch(() => '');
        }
        throw error;
      }
      const handle = db();
      handle.exec('BEGIN IMMEDIATE');
      try {
        handle.prepare('INSERT INTO comparisons (id, request_id, folder_id, source_chat_id, base_branch, base_sha, prompt, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, requestId, source.folderId, sourceId, baseBranch, baseSha, text, new Date().toISOString(), 'open');
        const insert = handle.prepare('INSERT INTO comparison_runs (comparison_id, ordinal, chat_id, folder_id, branch, worktree_path, provider_id, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        for (const row of rows) insert.run(id, row.ordinal, row.chat_id, row.folder_id, row.branch, row.worktree_path, row.provider_id, row.model);
        handle.exec('COMMIT');
      } catch (error) { handle.exec('ROLLBACK'); throw error; }

      for (const row of rows) {
        try {
          const staged = [];
          for (const file of payload) staged.push((await context.invoke('attachments.stage', {chatId: row.chat_id, name: file.name, mime: file.mime, dataBase64: file.data})).id);
          await context.invoke('chat.send', {id: row.chat_id, text, requestId: `${requestId.slice(0, 100)}-run${row.ordinal + 1}`, ...(staged.length ? {attachmentIds: staged} : {}),
            ...(skillIds?.length ? {skillIds} : {}), ...(pluginIds?.length ? {pluginIds} : {}), ...(effort ? {effort} : {})});
        } catch (error) {
          // One run that cannot start does not stop the others; its chat says why and the user can send again there.
          context.store.appendItem(row.chat_id, 'notice', `This run didn’t start: ${error instanceof Error ? error.message : String(error)}`, 'completed', {kind: 'compare-start-failed'});
        }
      }
      context.emitSnapshot();
      announce(id);
      return toComparison(groupRow(id));
    },

    'compare.list': () => (db().prepare('SELECT * FROM comparisons ORDER BY created_at DESC').all() as unknown as GroupRow[]).map(toComparison),

    'compare.get': async input => {
      const group = groupRow(input.id);
      const runs = runsOf(group.id);
      return {comparison: toComparison(group), runs: await Promise.all(runs.map(run => detailOf(group, run)))} satisfies ComparisonDetail;
    },

    'compare.fileDiff': async input => {
      const group = groupRow(input.id), chatId = idOf(input.chatId, 'a run');
      const run = runsOf(group.id).find(entry => entry.chat_id === chatId);
      if (!run) throw new Error('That run is not part of this comparison.');
      if (typeof input.path !== 'string' || !input.path || input.path.length > 4096) throw new Error('Choose a file.');
      if (!context.store.folder(run.folder_id)) throw new Error('This run’s worktree is gone.');
      return context.invoke('review.fileDiff', {folderId: run.folder_id, path: input.path, baseline: {ref: group.base_sha}});
    },

    'compare.pick': async input => {
      const group = groupRow(input.id), chatId = idOf(input.chatId, 'a run');
      if (group.state === 'merged') throw new Error('This comparison is already merged.');
      const runs = runsOf(group.id), winner = runs.find(run => run.chat_id === chatId);
      if (!winner) throw new Error('That run is not part of this comparison.');
      if (group.winner_chat_id && group.winner_chat_id !== chatId) throw new Error('Another run’s merge is in progress. Finish or abort it in Changes first.');
      const others = runs.filter(run => run !== winner);
      const working = runs.find(run => busy(context.store.chat(run.chat_id)));
      if (working) throw new Error(`${titleOf(working)} is still working. Wait for it or stop it before picking a run.`);
      const original = context.folderFor(group.folder_id);
      if (context.store.snapshot().chats.some(chat => chat.folderId === original.id && busy(chat))) throw new Error(`A chat is running in ${original.name}. Stop it before merging.`);
      const repo = await gitRepository(original.path);
      // Finishing a merge that stopped on conflicts reuses the keep/discard choices made when it started.
      let stored: Record<string, unknown> = {};
      try { stored = group.choices ? JSON.parse(group.choices) as Record<string, unknown> : {}; } catch { stored = {}; }
      const choices = {...stored, ...(input.others && typeof input.others === 'object' && !Array.isArray(input.others) ? input.others as Record<string, unknown> : {})};
      const decided = new Map<string, CompareChoice | 'none'>();
      for (const run of others) {
        const choice = choices[run.chat_id];
        if (choice === 'keep' || choice === 'discard') { decided.set(run.chat_id, choice); continue; }
        if (await hasWork(repo, group.base_sha, run)) throw new Error(`Choose whether to keep or discard the work in ${titleOf(run)} before picking a run.`);
        decided.set(run.chat_id, 'none');
      }

      const summary = clip(firstLine(group.prompt) || 'comparison run', 72);
      const merged = await serial(repo, async (): Promise<string[] | null> => {
        const branch = (await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
        if (branch !== group.base_branch) throw new Error(`Switch ${original.name} back to ${group.base_branch} before merging.`);
        const conflicts = await conflictState(repo);
        if (conflicts.operation) {
          if (conflicts.operation === 'merge' && group.winner_chat_id === chatId) {
            if (conflicts.files.length) return conflicts.files.map(file => file.path);
            throw new Error('Finish the merge in Changes (Continue), then pick this run again.');
          }
          throw new Error(`A ${conflicts.operation} is in progress in ${original.name}. Finish or abort it first.`);
        }
        await commitWork(winner, `${summary} (${winner.model})`);
        const tip = (await runGit(repo, ['rev-parse', `refs/heads/${winner.branch}`])).trim();
        const done = await runGit(repo, ['merge-base', '--is-ancestor', tip, 'HEAD']).then(() => true, () => false);
        if (done) return null;
        try {
          await runGit(repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${winner.branch}: ${summary} (${winner.model})`, winner.branch], 120000);
          return null;
        } catch (error) {
          const after = await conflictState(repo);
          if (after.operation === 'merge' && after.files.length) return after.files.map(file => file.path);
          throw error;
        }
      });
      context.emit({type: 'workspaceChanged', folderId: original.id});
      if (merged) {
        db().prepare("UPDATE comparisons SET state = 'merging', winner_chat_id = ?, choices = ? WHERE id = ?").run(chatId, JSON.stringify(Object.fromEntries([...decided].filter(([, choice]) => choice !== 'none'))), group.id);
        announce(group.id);
        return {status: 'conflicts', files: merged, comparison: toComparison(groupRow(group.id))} satisfies ComparePickResult;
      }

      // Merged: the others' work is committed on kept branches or thrown away on request, then every worktree goes.
      const outcome = db().prepare('UPDATE comparison_runs SET outcome = ? WHERE chat_id = ?');
      for (const run of others) {
        const choice = decided.get(run.chat_id);
        if (choice === 'discard') {
          await removeWorktree(repo, run, true);
          await runGit(repo, ['branch', '-D', run.branch]).catch(() => '');
          outcome.run('discarded', run.chat_id);
        } else {
          await commitWork(run, `${summary} (${run.model}, kept from a comparison)`);
          await removeWorktree(repo, run, false);
          const kept = choice === 'keep' && await branchExists(repo, run.branch);
          if (!kept) await runGit(repo, ['branch', '-d', run.branch]).catch(() => '');
          outcome.run(kept ? 'kept' : 'removed', run.chat_id);
        }
        const chat = context.store.chat(run.chat_id);
        if (chat && !chat.archived) await context.invoke('chat.update', {id: run.chat_id, archived: true});
        await forgetFolder(run.folder_id);
      }
      // The winner's chat carries on in the original checkout, where its work now is.
      if (context.store.chat(winner.chat_id)) await context.invoke('chat.update', {id: winner.chat_id, folderId: original.id});
      await removeWorktree(repo, winner, false);
      await runGit(repo, ['branch', '-d', winner.branch]).catch(() => '');
      outcome.run('winner', winner.chat_id);
      await forgetFolder(winner.folder_id);
      db().prepare("UPDATE comparisons SET state = 'merged', winner_chat_id = ? WHERE id = ?").run(chatId, group.id);
      context.emitSnapshot();
      announce(group.id);
      return {status: 'merged', comparison: toComparison(groupRow(group.id))} satisfies ComparePickResult;
    },
  }, dispose() { offStart(); offSettle(); }};
}
