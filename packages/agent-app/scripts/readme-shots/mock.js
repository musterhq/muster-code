// A fictional preload bridge (window.muster / window.musterMenu) for the README screenshots.
// It answers every command the renderer sends from window.__FX; commands it does not know are
// recorded in window.__unknownCommands and answered with an empty value so gaps are easy to spot.
(() => {
const FX = window.__FX;
const SHOT = window.__SHOT || '';
const OPTS = window.__SHOT_OPTS || {};
try { localStorage.clear(); sessionStorage.clear(); for (const [k, v] of Object.entries(OPTS.localStorage || {})) localStorage.setItem(k, v); } catch {}
const listeners = new Set();
const emit = (event) => { for (const listener of [...listeners]) { try { listener(event); } catch (error) { console.error(error); } } };
const unknown = window.__unknownCommands = new Set();
const {ROOT, INFRA, folders, projects, files, patches, stat, timelines, providers, memories, ago, edited} = FX;
const folderOf = (id) => folders.find(f => f.id === id) ?? folders[0];
const activeChatId = OPTS.activeChatId ?? 'c-hero';
// A single exchange for side-by-side typography checks: `replyMarkdown` (and optional `userText`) replace the active chat.
if (OPTS.replyMarkdown) {
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  timelines[activeChatId] = [
    {id: 'cmp-1', chatId: activeChatId, kind: 'user', text: OPTS.userText ?? 'Check it.', status: 'completed', createdAt: at(9)},
    {id: 'cmp-2', chatId: activeChatId, kind: 'assistant', text: OPTS.replyMarkdown, status: 'completed', createdAt: at(1)},
  ];
}
const snapshot = () => ({folders, chats: FX.chats, projects, activeChatId, version: 1, attention: {totalRequests: 0, chats: []}});
const text = (path) => files[path]?.after ?? files[path]?.before ?? `// ${path}\n`;
const blob = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(16).padStart(8, '0') + 'a3f1c9e2b7d4'; };

const settings = {'appearance.theme': OPTS.theme ?? 'dark', 'chat.inlineDiffs': true, 'general.defaultModel': {providerId: 'gateway', model: 'frontier-large', effort: 'medium'}};
const updateStatus = {phase: 'ready', current: '0.2.0', channel: 'stable', autoCheck: true, latest: {version: '0.2.1', notes: '- Faster timeline scrolling on long chats\n- Memory recall shows where each note came from\n- Fixes a terminal resize glitch', pageUrl: 'https://example.com/releases/0.2.1', publishedAt: ago(60 * 20)}, checkedAt: ago(12)};

// ---- git ------------------------------------------------------------------------------------
const gitFiles = [
  {path: 'src/models/task.ts', index: ' ', worktree: 'M', staged: false, untracked: false, conflict: false},
  {path: 'src/jobs/reminders.ts', index: '?', worktree: '?', staged: false, untracked: true, conflict: false},
  {path: 'web/src/components/TaskCard.tsx', index: ' ', worktree: 'M', staged: false, untracked: false, conflict: false},
];
const gitStatus = (folderId) => ({branch: folderId === 'f-infra' ? 'main' : 'feat/due-reminders', detached: false, unborn: false, revision: 'rev-1', files: folderId === 'f-infra' ? [] : gitFiles, truncated: false, stagedCount: 0, conflicted: false, upstream: 'origin/feat/due-reminders', ahead: 2, behind: 0});
const person = ['alex', 'sam', 'priya', 'jordan'];
const commit = (i, subject, refs = [], author = person[i % 4]) => ({sha: (blob(subject) + blob(subject + '#')).slice(0, 40), short: blob(subject).slice(0, 7), author, email: `${author}@taskboard.dev`, authoredAt: ago(60 * (i * 7 + 2)), subject, parents: [blob(subject + 'p')], refs, head: i === 0});
const commits = [
  commit(0, 'Add dueAt and reminder window to Task', ['feat/due-reminders'], 'alex'),
  commit(1, 'Extract notify() into its own module', [], 'alex'),
  commit(2, 'Merge pull request #41: board drag and drop', ['origin/main', 'main'], 'priya'),
  commit(3, 'Board: roll back optimistic moves on failure', [], 'priya'),
  commit(4, 'Freeze time in session-expiry test', [], 'sam'),
  commit(5, 'CI: cache npm installs', [], 'jordan'),
  commit(6, 'Release 0.3.0', ['v0.3.0'], 'alex'),
  commit(7, 'Task dialog: return focus to the opening card', [], 'sam'),
  commit(8, 'API: validate PATCH bodies with Task.partial()', [], 'alex'),
  commit(9, 'Web: empty state for new boards', [], 'priya'),
  commit(10, 'Seed script for demo data', [], 'jordan'),
  commit(11, 'Initial commit', [], 'alex'),
];
// Link the history into one line of parents, with the merge taking the board branch as its second parent.
commits.forEach((c, i) => { c.parents = commits[i + 1] ? [commits[i + 1].sha] : []; });
commits[2].parents = [commits[4].sha, commits[3].sha];
commits[3].parents = [commits[5].sha];
const reviewFiles = edited.map(path => { const p = patches[path]; const {adds, dels} = stat(p); return {path, status: files[path].before ? 'M' : 'A', adds, dels, beforeHash: files[path].before ? blob(files[path].before) : '', afterHash: blob(files[path].after), revision: blob(path + 'r')}; });

// ---- terminal / processes -------------------------------------------------------------------
const termOut = `\x1b[1;32malex@taskboard\x1b[0m \x1b[34m~/code/taskboard\x1b[0m \x1b[33m(feat/due-reminders)\x1b[0m $ npm test\r\n\r\n> taskboard@0.4.0-dev test\r\n> vitest run\r\n\r\n` + FX.TEST_OUTPUT.replace(/✓/g, '\x1b[32m✓\x1b[0m').replace(/passed/g, '\x1b[32mpassed\x1b[0m').replace(/\n/g, '\r\n') + `\r\n\x1b[1;32malex@taskboard\x1b[0m \x1b[34m~/code/taskboard\x1b[0m \x1b[33m(feat/due-reminders)\x1b[0m $ `;

const devOut = `\x1b[1;32malex@taskboard\x1b[0m \x1b[34m~/code/taskboard\x1b[0m $ npm run dev\r\n\r\n\x1b[36m[api]\x1b[0m listening on http://localhost:4000\r\n\x1b[35m[web]\x1b[0m ready in 412 ms\r\n\x1b[35m[web]\x1b[0m ➜  Local:   http://localhost:5173/\r\n\x1b[36m[api]\x1b[0m GET /tasks 200 12ms\r\n\x1b[36m[api]\x1b[0m PATCH /tasks/8f2c 200 9ms\r\n`;
const task = (id, title, state, extra = {}) => ({id, projectId: 'p-launch', title, status: {todo: 'todo', running: 'running', review: 'implemented', verified: 'verified', blocked: 'blocked', implemented: 'implemented'}[state] ?? 'todo', state, dependencies: [], acceptance: '', evidence: [], revision: 3, createdAt: ago(60 * 30), updatedAt: ago(extra.age ?? 30), owner: {kind: 'agent', id: 'agent'}, priority: 2, artifacts: [], attempts: [], verification: null, permissionMode: null, budgetMinutes: null, blockedBy: null, ready: state === 'todo', verificationStale: false, waitingChatId: null, ...extra});
const projectWork = (projectId) => ({
  tasks: {truncated: false, items: [
    task('t1', 'Due-date reminders on tasks', 'review', {runChatId: 'c-hero', acceptance: 'Reminder sent once per task; all tests pass.', priority: 1, evidence: ['31 tests passed'], age: 2}),
    task('t2', 'Keyset pagination for GET /tasks', 'running', {runChatId: 'c-paginate', acceptance: 'Stable pages of 50 while tasks are added.', priority: 1, age: 1}),
    task('t3', 'Board view: drag cards between columns', 'verified', {runChatId: 'c-board', verification: {kind: 'tests', command: 'npm test', notes: 'CI green on #41', verifiedAt: ago(60 * 3)}, age: 190}),
    task('t4', 'Staging bucket for attachments', 'implemented', {runChatId: 'c-bucket', age: 80}),
    task('t5', 'DueBadge with overdue styling', 'todo', {dependencies: ['t1'], ready: false, owner: {kind: 'user', id: 'alex'}}),
    task('t6', 'Write the 0.4 release notes', 'todo', {dependencies: ['t1', 't2', 't3'], ready: false, runChatId: 'c-notes'}),
    task('t7', 'Announce the launch', 'todo', {dependencies: ['t6'], ready: false, owner: {kind: 'user', id: 'alex'}, priority: 3}),
  ]},
  decisions: {truncated: false, items: [
    {id: 'd1', projectId, title: 'Reminders go out once, tracked with remindedAt', rationale: 'Avoids duplicate notifications when the job restarts.', author: 'alex', scope: 'api', relatedTaskIds: ['t1'], status: 'active', supersededById: null, createdAt: ago(60 * 4), updatedAt: ago(60 * 4)},
    {id: 'd2', projectId, title: 'Page tokens encode (createdAt, id)', rationale: 'Stable ordering without offsets.', author: 'alex', scope: 'api', relatedTaskIds: ['t2'], status: 'active', supersededById: null, createdAt: ago(60 * 2), updatedAt: ago(60 * 2)},
  ]},
  activity: {truncated: false, items: [
    {id: 'a1', projectId, actor: 'agent', kind: 'task.review', summary: 'Due-date reminders on tasks is ready for review', refId: 't1', createdAt: ago(2)},
    {id: 'a2', projectId, actor: 'agent', kind: 'task.started', summary: 'Started Keyset pagination for GET /tasks', refId: 't2', createdAt: ago(9)},
    {id: 'a3', projectId, actor: 'alex', kind: 'task.verified', summary: 'Verified Board view: drag cards between columns', refId: 't3', createdAt: ago(60 * 3)},
  ]},
  scheduler: {autoDispatch: true, paused: false, concurrency: 2, budgetMinutes: 30, permissionMode: 'workspace', updatedAt: ago(60 * 24)},
  instructions: {version: 2, text: 'Keep PRs small. Every task needs tests. Ask before touching migrations.', updatedAt: ago(60 * 24 * 2)},
  context: {version: 7, goalVersion: 1, instructionsVersion: 2, decisions: 2, headSha: commits[0].sha, label: 'v7'},
  coordinator: {chatId: 'c-plan', proposals: []},
  dispatching: ['t2'],
  eventSeq: 12,
});
const computerStatus = (scope) => ({id: 'sbx-hero', scope: scope ?? {kind: 'chat', id: 'c-hero'}, label: 'Add due-date reminders to tasks', provider: 'local-docker', state: 'running', workspacePreserved: true, durability: 'scratch', image: 'muster/sandbox:24-bookworm', user: 'agent', limits: {network: 'none', memoryMiB: 1024, cpus: 2, processes: 256, maxRunning: 2, maxTimeoutMs: 30 * 60_000}, layers: [{id: 'skills', label: 'Your skills', version: '3f9a1c0d2b7e', target: '/opt/muster/skills'}], bootGeneration: 1});
const handlers = {
  'app.snapshot': snapshot,
  'chat.timeline': ({id}) => ({items: timelines[id] ?? [], revision: 1}),
  'chat.select': ({id}) => timelines[id] ?? [],
  'chat.contextTelemetry': ({id}) => ({usedTokens: id === 'c-hero' ? 48210 : 12000, windowTokens: 400000, source: 'live', compacted: false, updatedAt: ago(1), breakdown: [{label: 'System and tools', tokens: 9800}, {label: 'Conversation', tokens: 21400}, {label: 'Files read', tokens: 17010}]}),
  'chat.editOwners': () => edited.map(path => ({path, chatId: 'c-hero', title: 'Add due-date reminders to tasks', status: 'completed'})),
  'chat.update': ({id, ...patch}) => ({...FX.chats.find(c => c.id === id), ...patch}),
  'chat.search': ({query}) => { const q = String(query || '').toLowerCase(); if (!q) return []; const hits = [['c-hero', '…a job that sends one reminder per task, and show a due badge on the board card.'], ['c-notes', 'Drafted CHANGELOG.md with Reminders, Pagination and Board view sections.'], ['c-flaky', 'Session reminders were skipped when the clock moved during the test.']]; return hits.filter(([, t]) => t.toLowerCase().includes(q)).map(([chatId, snippet]) => { const at = snippet.toLowerCase().indexOf(q); return {chatId, snippet, ranges: [[at, at + q.length]], matches: 1}; }); },
  'providers.list': () => providers,
  'providers.check': ({id}) => providers.find(p => p.id === id),
  'settings.get': () => ({values: settings}),
  'settings.set': ({key, value}) => { settings[key] = value; return {values: settings}; },
  'updates.status': () => updateStatus,
  'updates.check': () => updateStatus,
  'workspace.watch': () => undefined,
  'files.nativeAvailable': () => false,
  'files.list': ({folderId, path}) => {
    const tree = folderId === 'f-infra' ? {'': ['modules/', 'envs/', 'main.tf', 'README.md']} : {
      '': ['.github/', 'src/', 'web/', 'scripts/', 'package.json', 'README.md', 'tsconfig.json', 'CHANGELOG.md'],
      src: ['api/', 'jobs/', 'models/', 'db.ts', 'notify.ts', 'server.ts'], 'src/api': ['tasks.ts', 'users.ts', 'tasks.test.ts'], 'src/jobs': ['index.ts', 'reminders.ts', 'reminders.test.ts'], 'src/models': ['task.ts', 'task.test.ts', 'user.ts'],
      web: ['src/', 'index.html', 'vite.config.ts'], 'web/src': ['components/', 'api.ts', 'App.tsx', 'main.tsx'], 'web/src/components': ['Avatar.tsx', 'Board.tsx', 'Column.tsx', 'TaskCard.tsx', 'TaskDialog.tsx'],
      scripts: ['seed.ts'], '.github': ['workflows/'], '.github/workflows': ['ci.yml'],
    };
    return (tree[path ?? ''] ?? []).map(name => ({name: name.replace(/\/$/, ''), path: (path ? path + '/' : '') + name.replace(/\/$/, ''), kind: name.endsWith('/') ? 'directory' : 'file'}));
  },
  'files.read': ({path}) => ({path, text: text(path), truncated: false}),
  'files.readFull': ({path}) => ({path, text: text(path), truncated: false, revision: blob(text(path)), encodingWarning: false}),
  'files.annotations.list': () => [],
  'files.search': ({query}) => ({entries: Object.keys(files).filter(p => p.toLowerCase().includes(String(query).toLowerCase())).map(p => ({name: p.split('/').at(-1), path: p, kind: 'file'})), truncated: false}),
  'files.quickOpen': ({folderId, query}) => ({results: folderId === 'f-infra' ? [] : [...Object.keys(files), 'src/jobs/reminders.test.ts', 'src/jobs/index.ts', 'web/src/components/DueBadge.tsx'].filter(p => p.toLowerCase().includes(String(query ?? '').toLowerCase().slice(0, 6))).map((path, i) => ({path, score: 100 - i}))}),
  'git.changes': ({folderId}) => folderId === 'f-infra' ? [] : reviewFiles.map(({path, status, adds, dels}) => ({path, status, adds, dels})),
  'git.status': ({folderId}) => gitStatus(folderId),
  'git.diff': ({path}) => ({path, before: files[path]?.before ?? '', after: files[path]?.after ?? '', truncated: false}),
  'git.info': ({folderId}) => ({branch: gitStatus(folderId).branch, detached: false, fetchedAt: ago(20), hasRemote: true, worktree: null}),
  'git.branches': () => ({current: 'feat/due-reminders', detached: false, local: [{name: 'feat/due-reminders', upstream: 'origin/feat/due-reminders', ahead: 2, behind: 0, worktreePath: ROOT, committedAt: ago(20)}, {name: 'main', upstream: 'origin/main', ahead: 0, behind: 0, committedAt: ago(60 * 9)}, {name: 'feat/keyset-pagination', upstream: 'origin/feat/keyset-pagination', ahead: 1, behind: 3, committedAt: ago(60 * 3)}], recent: ['main', 'feat/keyset-pagination'], truncated: false}),
  'git.headMessage': () => ({message: commits[0].subject}),
  'git.log': () => ({commits, hasMore: false, skip: 0}),
  'git.commitDetail': ({sha}) => { const c = commits.find(x => x.sha === sha) ?? commits[0]; return {commit: c, body: 'Tasks can carry a due date and a reminder window.\nisDueSoon() decides when the window is open.', base: commits[1].sha, files: [{path: 'src/models/task.ts', status: 'M', adds: 9, dels: 0, binary: false}, {path: 'src/models/task.test.ts', status: 'M', adds: 24, dels: 1, binary: false}], truncated: false}; },
  'git.refDiff': ({path}) => ({path, before: files[path]?.before ?? '', after: files[path]?.after ?? '', truncated: false, binary: false}),
  'git.pullRequests': () => ({available: true, items: [{number: 42, title: 'Due-date reminders', url: 'https://example.com/taskboard/pull/42', state: 'OPEN', headRefName: 'feat/due-reminders', isDraft: true}]}),
  'git.compareUrl': () => ({url: null, reason: 'Demo'}),
  'git.worktree.list': () => [{path: ROOT, branch: 'feat/due-reminders', head: commits[0].sha, main: true, current: true, dirty: true, locked: false, prunable: false}],
  'git.conflicts': () => ({operation: null, currentLabel: '', incomingLabel: '', incomingSubject: null, files: [], canContinue: false}),
  'review.baselines': ({chatId}) => chatId === 'c-hero' ? [{runId: 'run-hero', chatId, folderId: 'f-taskboard', treeSha: 'abc123', at: ago(9)}] : [],
  'review.changes': ({baseline}) => ({baseline, label: typeof baseline === 'object' && 'runId' in baseline ? 'This turn' : 'Uncommitted changes', files: reviewFiles, truncated: false}),
  'review.fileDiff': ({path, baseline}) => { const f = reviewFiles.find(x => x.path === path) ?? reviewFiles[0]; return {path: f.path, status: f.status, before: files[f.path]?.before ?? '', after: files[f.path]?.after ?? '', truncated: false, size: {before: (files[f.path]?.before ?? '').length, after: files[f.path].after.length}, beforeHash: f.beforeHash, afterHash: f.afterHash, revision: f.revision, label: 'This turn'}; },
  'review.marks': () => [],
  'memory.list': ({folderId}) => memories.filter(m => !folderId || m.scopes.some(s => s.kind === 'user' || s.id === folderId)),
  'memory.search': ({query}) => memories.filter(m => m.summary.toLowerCase().includes(String(query).toLowerCase())),
  'processes.summary': () => ({revision: 1, sessions: []}),
  'processes.list': () => ({revision: 1, sessions: []}),
  'terminal.list': ({chatId}) => OPTS.terminal ? [{id: 't2', chatId, title: 'npm run dev', cwd: ROOT, shell: '/bin/zsh', owner: 'user', status: 'running', startedAt: ago(40), exitCode: null, end: devOut.length}, {id: 't1', chatId, title: 'zsh', cwd: ROOT, shell: '/bin/zsh', owner: 'user', status: 'running', startedAt: ago(6), exitCode: null, end: termOut.length}] : [],
  'terminal.snapshot': ({id}) => { const data = id === 't2' ? devOut : termOut; return {data, truncatedBytes: 0, omittedLines: 0, end: data.length}; },
  'terminal.create': ({chatId}) => ({id: 't3', chatId, title: 'zsh', cwd: ROOT, shell: '/bin/zsh', owner: 'user', status: 'running', startedAt: ago(0), exitCode: null}),
  'terminal.resize': () => undefined,
  'terminal.input': () => undefined,
  'terminalAccess.get': ({chatId}) => ({chatId, allowed: true, allowedAt: ago(30)}),
  'attachments.list': () => [],
  'attachments.info': () => [],
  'plugins.list': () => FX.skills,
  'plugins.inventory': () => FX.plugins,

  // ---- memory -------------------------------------------------------------------------------
  'memory.browse': ({query}) => ({records: memories.filter(m => !query || m.summary.toLowerCase().includes(String(query).toLowerCase())).map(m => ({id: m.id, source: m.scopes[0].kind === 'user' ? 'local' : 'hindsight', text: m.summary, kind: m.kind, observedAt: m.observedAt, scope: {kind: m.scopes[0].kind, id: m.scopes[0].id, label: m.scopes[0].kind === 'user' ? 'Personal' : 'taskboard'}, provenance: m.provenance.map(p => p.startsWith('chat:') ? (FX.chats.find(c => 'chat:' + c.id === p)?.title ?? p) : p), deletable: true, ...(m.tags ? {tags: m.tags} : {})})), status: {connection: 'connected', endpoint: 'http://localhost:8888', bankId: 'alex', checkedAt: ago(2)}}),
  'memory.config.get': () => ({endpoint: 'http://localhost:8888', hasApiKey: false, keyStorage: 'none', autoRecall: true, autoRetain: 'ask', source: 'app'}),
  'memory.status': () => ({connection: 'connected', endpoint: 'http://localhost:8888', bankId: 'alex', checkedAt: ago(2)}),
  'memory.offers': () => ({offers: [{itemId: 'h11', chatId: 'c-hero', chatTitle: 'Add due-date reminders to tasks', runId: 'run-hero', summary: 'Reminder jobs mark remindedAt so each task is reminded once.', createdAt: ago(2)}]}),
  'memory.deletes.list': () => ({deletes: []}),
  'memory.recall.preview': ({prompt}) => ({enabled: true, engine: true, records: String(prompt || '').length > 3 ? [
    {id: 'm5', text: memories.find(m => m.id === 'm5').summary, source: 'hindsight', scope: 'taskboard', observedAt: ago(8)},
    {id: 'm3', text: memories.find(m => m.id === 'm3').summary, source: 'hindsight', scope: 'taskboard', observedAt: ago(45)},
    {id: 'm1', text: memories.find(m => m.id === 'm1').summary, source: 'local', scope: 'Personal', observedAt: ago(60 * 24 * 6)},
  ] : [], excluded: []}),
  // ---- providers / setup --------------------------------------------------------------------
  'providers.accounts.list': () => ({accounts: []}),
  'providers.diagnose': ({id}) => ({id, stage: 'ok', summary: 'Checks passed', version: null, checkedAt: ago(1), diagnostics: ''}),
  'providers.secret.status': () => ({stored: true, updatedAt: ago(60 * 24 * 12), secureStorage: true}),
  'providers.cli.status': () => [],
  'providers.usage': () => null,
  'setup.status': () => ({checkedAt: ago(1), platform: 'darwin', clis: [], connections: providers.map(p => ({id: p.id, name: p.name, kind: p.id === 'ollama' || p.id === 'lmstudio' ? 'local' : p.id === 'openrouter' ? 'env' : 'gateway', ready: true, detail: p.identityMasked})), readyProviders: providers.map(p => ({id: p.id, name: p.name})), git: {available: true, version: '2.47.0', detail: 'git 2.47.0'}, docker: {installed: true, running: true, version: '28.1.1', detail: 'Running'}}),
  'setup.progress': () => ({step: 'done', startedAt: ago(60 * 24 * 20), completedAt: ago(60 * 24 * 20), dismissedAt: null, skipped: []}),
  'setup.refresh': () => ({providers}),
  'models.policy.get': () => ({hidden: [], pricing: {}}),
  'sandbox.chatEnvironment.get': ({chatId}) => OPTS.sandbox ? {chatId, env: 'sandbox', mode: 'copy', ready: true, browser: 'host', workspacePath: `${FX.HOME}/Library/Application Support/Muster/sandboxes/${chatId}/workspace`, seededAt: ago(9)} : {chatId, env: 'host', mode: 'copy', ready: true, browser: 'host'},
  'processes.ports': ({chatId}) => ({chatId, ports: OPTS.ports ? [{id: 'port-1', port: 5173, address: '127.0.0.1', name: 'node', owner: 'user', source: {kind: 'terminal', id: 't1'}}, {id: 'port-2', port: 4000, address: '127.0.0.1', name: 'node', owner: 'agent', source: {kind: 'agent'}}] : [], supported: true, scannedAt: ago(0)}),
  'ci.repair.list': () => [],
  'artifacts.sideChat.list': () => ({sideChats: []}),
  'computer.permissions': () => ({platform: 'darwin', accessibility: 'granted', screen: 'granted'}),
  'settings.terminalShells': () => ({shells: [{id: 'zsh', label: 'zsh', path: '/bin/zsh'}, {id: 'bash', label: 'bash', path: '/bin/bash'}], selected: {file: '/bin/zsh'}}),
  'github.pr.checks': () => ({headSha: commits[0].sha, items: [], summary: {passed: 4, failed: 0, pending: 1, skipped: 0}}),


  // ---- projects ------------------------------------------------------------------------------
  'project.list': () => projects.map(p => ({...p, primaryFolderId: p.primaryFolderId ?? null, archived: false, archivedAt: null})),
  'settings.projectModel.get': () => ({value: null}),
  'settings.folderModel.get': () => ({value: null}),
  'project.work': ({projectId}) => projectWork(projectId),
  'project.events': () => ({events: [], nextSeq: 12, hasMore: false}),
  'project.members.list': () => ({members: []}),
  'project.sources.list': () => ({sources: []}),
  'project.handoff.latest': () => ({packet: null}),
  'models.usage.project': () => null,
  'models.usage.chat': () => null,
  // ---- sandbox / scoped computer -------------------------------------------------------------
  'sandbox.changes': ({chatId}) => ({chatId, folderId: 'f-taskboard', files: [{path: 'src/models/task.ts', status: 'modified', bytes: 912}, {path: 'src/jobs/reminders.ts', status: 'added', bytes: 1034}, {path: 'web/src/components/TaskCard.tsx', status: 'modified', bytes: 418}], truncated: false}),
  'sandbox.fileDiff': ({path}) => ({path, status: 'modified', patch: patches[path] ?? '', truncated: false}),
  'computer.inspect': ({scope}) => computerStatus(scope),
  'computer.start': ({scope}) => computerStatus(scope),
  'computer.history': () => [
    {executionId: 'x3', computerId: 'sbx-hero', state: 'completed', stdout: FX.TEST_OUTPUT.replace(FX.ROOT, '/workspace'), stderr: '', stdoutTruncated: false, stderrTruncated: false, exitCode: 0, computerStopped: false, command: 'npm test', startedAt: ago(4), endedAt: ago(3.9)},
    {executionId: 'x2', computerId: 'sbx-hero', state: 'completed', stdout: 'added 412 packages in 9s\n', stderr: '', stdoutTruncated: false, stderrTruncated: false, exitCode: 0, computerStopped: false, command: 'npm ci', startedAt: ago(7), endedAt: ago(6.8)},
    {executionId: 'x1', computerId: 'sbx-hero', state: 'completed', stdout: 'v24.4.0\n', stderr: '', stdoutTruncated: false, stderrTruncated: false, exitCode: 0, computerStopped: false, command: 'node --version', startedAt: ago(8), endedAt: ago(8)},
  ],
  'computer.files.list': ({path}) => ({path: path || '/workspace', entries: ['src', 'web', 'node_modules', 'package.json', 'README.md', 'tsconfig.json'].map((name, i) => ({name, path: `/workspace/${name}`, kind: i < 3 ? 'directory' : 'file', size: i < 3 ? 0 : 1200 + i * 310, modifiedAt: ago(5 + i)})), truncated: false}),
  'computer.usage': () => ({computerId: 'sbx-hero', running: true, memoryBytes: 188 * 1024 * 1024, memoryLimitBytes: 1024 * 1024 * 1024, cpuPercent: 3.2, pids: 14, sampledAt: ago(0)}),
  'computer.workspace.size': () => ({bytes: 212 * 1024 * 1024, files: 18342, truncated: false}),
  'computer.services.list': () => ({computerId: 'sbx-hero', bootGeneration: 1, services: [{id: 'svc-api', name: 'api', command: 'npm run dev:api', cwd: '/workspace', restart: 'on-failure', state: 'running', bootGeneration: 1, restarts: 0, lastExitCode: null, startedAt: ago(6), output: 'listening on http://0.0.0.0:4000\n'}]}),
  'computer.layers.sources': () => ({sources: [{id: 'skills', label: 'Your skills', available: true}, {id: 'tools', label: 'Muster tools', available: true}], active: [{id: 'skills', label: 'Your skills', version: '3f9a1c0d2b7e', target: '/opt/muster/skills'}]}),
  // ---- skills, plugins, automations ---------------------------------------------------------
  'extensions.sources.list': () => [],
  'extensions.catalog': () => [],
  'extensions.installed': () => [],
  'extensions.enablement.list': () => [],
  'extensions.inventory': () => ({skills: FX.skills, plugins: FX.plugins}),
  'automations.list': () => FX.automations,
  'automations.runs': ({id}) => FX.automationRuns.filter(r => r.automationId === id),
};
window.__mockHandlers = handlers;

const fallback = (command) => {
  if (/\.(list|browse|history|sources|catalog|installed|inventory|marks|archives|observations|directives|offers|baselines|captureSources)$/.test(command)) return [];
  return null;
};

window.muster = {
  async invoke(command, input) {
    const handler = handlers[command];
    if (!handler) { unknown.add(command); return fallback(command); }
    return structuredClone(await handler(input ?? {}));
  },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
};
window.musterMenu = {onAction() { return () => {}; }, closeWindow() {}};
window.__emit = emit;
})();
