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
// Computer use (local shots): the agent drives Mail, Notes and a staging page; each step carries a fake window
// picture (inline SVG) so the PiP stack and the transcript rows have real frames to show.
const fakeWindow = ({title, accent, kind}) => {
  const rows = (x, y, n, w, gap = 30, fill = '#e7e9ee') => Array.from({length: n}, (_, i) => `<rect x="${x}" y="${y + i * gap}" width="${w - (i % 3) * 60}" height="12" rx="6" fill="${fill}"/>`).join('');
  const chrome = `<rect width="1280" height="800" fill="#ffffff"/><rect width="1280" height="52" fill="#f3f4f6"/><circle cx="26" cy="26" r="7" fill="#ff5f57"/><circle cx="48" cy="26" r="7" fill="#febc2e"/><circle cx="70" cy="26" r="7" fill="#28c840"/>`;
  let body = '';
  if (kind === 'browser') body = `<rect x="120" y="12" width="760" height="28" rx="14" fill="#ffffff" stroke="#dcdfe4"/><text x="140" y="31" font-family="Helvetica" font-size="15" fill="#555">${title}</text><rect y="52" width="1280" height="64" fill="${accent}"/><text x="40" y="94" font-family="Helvetica" font-weight="bold" font-size="24" fill="#fff">Taskboard UAT</text><rect x="40" y="150" width="760" height="240" rx="12" fill="#f5f7fb" stroke="#e3e6ec"/><text x="70" y="200" font-family="Helvetica" font-weight="bold" font-size="26" fill="#1c2230">Solution #482: due-date reminders</text>${rows(70, 236, 4, 620)}<rect x="840" y="150" width="400" height="520" rx="12" fill="#f5f7fb" stroke="#e3e6ec"/>${rows(870, 190, 12, 320, 36)}<rect x="40" y="420" width="760" height="250" rx="12" fill="#fff4f2" stroke="#f3c6bd"/><text x="70" y="468" font-family="Helvetica" font-weight="bold" font-size="22" fill="#b3361e">Failed to load solution details</text>${rows(70, 500, 4, 600, 30, '#f6d8d1')}`;
  else if (kind === 'mail') body = `<text x="560" y="33" font-family="Helvetica" font-weight="bold" font-size="16" fill="#444">Inbox</text><rect y="52" width="300" height="748" fill="#f7f8fa"/>${Array.from({length: 7}, (_, i) => `<rect x="12" y="${68 + i * 96}" width="276" height="84" rx="10" fill="${i === 1 ? accent : '#ffffff'}"/><rect x="28" y="${86 + i * 96}" width="150" height="12" rx="6" fill="${i === 1 ? '#ffffff' : '#c8ccd4'}"/><rect x="28" y="${110 + i * 96}" width="220" height="10" rx="5" fill="${i === 1 ? '#dbe8ff' : '#e3e6ec'}"/>`).join('')}<text x="340" y="110" font-family="Helvetica" font-weight="bold" font-size="28" fill="#1c2230">UAT: solution page won't load</text><text x="340" y="146" font-family="Helvetica" font-size="16" fill="#6b7280">QA Team · 09:12</text>${rows(340, 190, 10, 820, 34)}`;
  else body = `<rect y="52" width="260" height="748" fill="#fbf6e6"/>${rows(24, 84, 12, 200, 44, '#efe3bb')}<text x="300" y="110" font-family="Helvetica" font-weight="bold" font-size="30" fill="#1c2230">${title}</text>${rows(300, 150, 14, 880, 36)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">${chrome}${body}</svg>`;
  return {dataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), mime: 'image/svg+xml', width: 1280, height: 800, bytes: svg.length};
};
const PAGE = 'https://uat.taskboard.dev/solutions/482';
if (OPTS.computerUse) {
  const at = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
  const cu = (id, server, tool, args, seconds, extra = {}) => ({id, chatId: activeChatId, kind: 'tool', text: '', status: 'completed', createdAt: at(seconds), data: {type: 'mcpToolCall', server, tool, arguments: JSON.stringify(args), ...extra}});
  const mail = fakeWindow({title: 'Inbox', accent: '#2f6fed', kind: 'mail'});
  const notes = fakeWindow({title: 'UAT checklist', accent: '#e8b100', kind: 'notes'});
  const page = fakeWindow({title: 'uat.taskboard.dev/solutions/482', accent: '#3a5bd9', kind: 'browser'});
  timelines[activeChatId] = [
    {id: 'cu-u', chatId: activeChatId, kind: 'user', text: 'QA says the UAT solution page will not load. Read their report in Mail, then check the page and tell me what is wrong.', status: 'completed', createdAt: at(200)},
    cu('cu-1', 'computer-use', 'open_app', {app: 'Mail'}, 190),
    cu('cu-2', 'computer-use', 'screenshot', {app: 'Mail'}, 186, {images: [mail]}),
    cu('cu-3', 'computer-use', 'click', {app: 'Mail', element: 'UAT: solution page won\'t load'}, 180),
    {id: 'cu-4', chatId: activeChatId, kind: 'tool', text: '', status: 'completed', createdAt: at(170), data: {type: 'commandExecution', command: "sed -n '1,120p' src/api/solutions.ts", commandActions: [{type: 'read', path: 'src/api/solutions.ts', name: 'solutions.ts'}], exitCode: 0, durationMs: 80}},
    cu('cu-5', 'computer-use', 'screenshot', {app: 'Notes'}, 150, {images: [notes]}),
    cu('cu-6', 'muster_browser', 'browser_navigate', {url: PAGE}, 60, {images: [page]}),
    cu('cu-7', 'muster_browser', 'browser_snapshot', {}, 40),
    {id: 'cu-8', chatId: activeChatId, kind: 'tool', text: '', status: 'completed', createdAt: at(30), data: {type: 'commandExecution', command: `curl -sI ${PAGE}`, commandActions: [], exitCode: 0, durationMs: 300, output: 'HTTP/2 500\n'}},
    {...cu('cu-9', 'muster_browser', 'browser_click', {element: 'Retry loading details', ref: 'e41'}, 1), status: OPTS.computerUse === 'done' ? 'completed' : 'running'},
  ];
  if (OPTS.computerUse === 'done') timelines[activeChatId].push({id: 'cu-a', chatId: activeChatId, kind: 'assistant', text: 'The solution page returns **HTTP 500**: `GET /api/solutions/482` throws because the solution has no owner. QA\'s report in Mail matches.', status: 'completed', createdAt: at(0.5)});
  const hero = FX.chats.find(c => c.id === activeChatId); if (hero && OPTS.computerUse !== 'done') hero.status = 'running';
  // The agent's browser pushes live frames, so the front card reads as live.
  if (OPTS.computerUse === true) setInterval(() => emit({type: 'computerFrame', frame: {chatId: activeChatId, owner: `browser:agent-${activeChatId}`, profileId: 'personal', dataUrl: page.dataUrl, width: 1280, height: 800, url: PAGE, title: 'uat.taskboard.dev', action: 'Clicking “Retry loading details”', at: Date.now()}}), 400);
}
if (OPTS.computerUse === 'ghost' || OPTS.computerUse === 'starting') {
  // #360: 'ghost' = browser used minutes ago, the current turn is shell work; 'starting' = a browser step just began, no frame yet.
  const stamp = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
  const shell = {id: 'cu-sh', chatId: activeChatId, kind: 'tool', text: '', status: 'running', createdAt: stamp(1), data: {type: 'commandExecution', command: 'jenkins-cli build deploy-staging', commandActions: [], exitCode: null}};
  timelines[activeChatId] = OPTS.computerUse === 'starting'
    ? [timelines[activeChatId][0], {id: 'cu-st', chatId: activeChatId, kind: 'tool', text: '', status: 'running', createdAt: stamp(2), data: {type: 'mcpToolCall', server: 'muster_browser', tool: 'browser_navigate', arguments: JSON.stringify({url: PAGE})}}]
    : [...timelines[activeChatId].map(item => ({...item, createdAt: new Date(Date.parse(item.createdAt) - 600_000).toISOString(), data: item.data && item.data.images ? {...item.data, images: undefined} : item.data})), shell];
}
if (OPTS.computerUse === 'ended') {
  // #360: the agent browser pushes frames, then the run ends; the card reads Ended and then goes away.
  const frame = () => emit({type: 'computerFrame', frame: {chatId: activeChatId, owner: `browser:agent-${activeChatId}`, profileId: 'personal', dataUrl: fakeWindow({title: 'uat.taskboard.dev/solutions/482', accent: '#3a5bd9', kind: 'browser'}).dataUrl, width: 1280, height: 800, url: PAGE, title: 'uat.taskboard.dev', action: 'Opened uat.taskboard.dev', at: Date.now()}});
  const timer = setInterval(frame, 400); setTimeout(() => clearInterval(timer), 1200);
  setTimeout(() => { const hero = FX.chats.find(c => c.id === activeChatId); if (hero) hero.status = 'completed'; emit({type: 'snapshot', snapshot: snapshot()}); }, 1800);
}
window.__emitShotEvent = (event) => emit(event);
const snapshot = () => ({folders, chats: FX.chats, projects, activeChatId, version: 1, attention: {totalRequests: 0, chats: []}});
const text = (path) => files[path]?.after ?? files[path]?.before ?? `// ${path}\n`;
const blob = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(16).padStart(8, '0') + 'a3f1c9e2b7d4'; };

const settings = {'appearance.theme': OPTS.theme ?? 'dark', ...(OPTS.darkTheme ? {'appearance.darkTheme': OPTS.darkTheme} : {}), ...(OPTS.lightTheme ? {'appearance.lightTheme': OPTS.lightTheme} : {}), 'chat.inlineDiffs': true, 'general.defaultModel': OPTS.realisticModels ? {providerId: 'openai-direct', model: 'gpt-6.1-sol', effort: 'high'} : {providerId: 'gateway', model: 'frontier-large', effort: 'medium'}};
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
  // New project → Sources → Choose folder…: the native picker answers with a folder the fixtures do not list yet.
  'folder.pick': () => ({id: 'f-docs', path: FX.HOME + '/Code/taskboard-docs', name: 'taskboard-docs'}),
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
  'models.policy.get': () => ({hidden: [], shown: [], pricing: {}}),
  'chat.defaults': () => { const d = settings['general.defaultModel']; return {providerId: d.providerId, model: d.model, ...(d.effort ? {effort: d.effort} : {}), source: 'user'}; },
  'sandbox.chatEnvironment.get': ({chatId}) => OPTS.sandbox ? {chatId, env: 'sandbox', mode: 'copy', ready: true, browser: 'host', workspacePath: `${FX.HOME}/Library/Application Support/Muster/sandboxes/${chatId}/workspace`, seededAt: ago(9)} : {chatId, env: 'host', mode: 'copy', ready: true, browser: 'host'},
  'processes.ports': ({chatId}) => ({chatId, ports: OPTS.ports ? [{id: 'port-1', port: 5173, address: '127.0.0.1', name: 'node', owner: 'user', source: {kind: 'terminal', id: 't1'}}, {id: 'port-2', port: 4000, address: '127.0.0.1', name: 'node', owner: 'agent', source: {kind: 'agent'}}] : [], supported: true, scannedAt: ago(0)}),
  'ci.repair.list': () => [],
  'artifacts.sideChat.list': () => ({sideChats: []}),
  'computer.permissions': () => ({platform: 'darwin', accessibility: 'granted', screen: 'granted'}),
  'computer.control': ({chatId, owner}) => { setTimeout(() => emit({type: 'computerControl', chatId, owner}), 0); return {chatId, owner}; },
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

// ---- devices (#363): a fictional Xcode + Android SDK, the helper, and live screens drawn on a canvas -----------------
// Every device carries the frame spec main would derive (simctl device type, or the AVD's config.ini), and shows a home
// screen in its own OS's style. All art is drawn here from plain shapes: no maker icons, wallpapers or marks.
if (OPTS.devices) {
  const mode = OPTS.devices;
  const ok = (detail) => ({available: true, detail});
  const setup = () => ({enabled: !['off', 'missing'].includes(mode), agentControl: mode === 'agent', appleModels: true, models: [{id: 'iphone', label: 'iPhone', state: 'absent'}, {id: 'ipad', label: 'iPad', state: 'absent'}], host: OPTS.host ?? 'darwin',
    helper: {state: mode === 'installing' ? 'installing' : mode === 'failed' ? 'failed' : mode === 'off' || mode === 'missing' ? 'absent' : 'installed', version: '0.15.3', downloadMB: 26, running: ['live', 'agent', 'tablet', 'android', 'error'].includes(mode), ...(mode === 'installing' ? {progress: 'Downloading the device helper…'} : {}), ...(mode === 'failed' ? {error: 'Could not reach the npm registry. Check your internet connection (or proxy) and try again.'} : {})},
    ios: mode === 'missing' ? {available: false, reason: 'Xcode is not installed.', fix: ['Install Xcode from the App Store.', 'Open Xcode once and let it install its components.', 'In Terminal run: sudo xcode-select -s /Applications/Xcode.app']} : ok('Xcode 26.1'),
    android: mode === 'missing' ? {available: false, reason: 'Android SDK not found.', fix: ['Install Android Studio from developer.android.com/studio.', 'In Android Studio open Settings › Languages & Frameworks › Android SDK and install the Android Emulator and Android SDK Platform-Tools.', 'Create a virtual device in Device Manager.'], detail: 'Looked in ~/Library/Android/sdk'} : ok('Android SDK at ~/Library/Android/sdk'),
    node: ok('24.4.0')});
  const FIXTURES = {
    iphone17pro: {id: '6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A', name: 'iPhone 17 Pro', platform: 'ios', osVersion: 'iOS 26.0', type: 'iPhone-17-Pro'},
    iphone16e: {id: '1A2B3C4D-1111-4C55-9A0B-1F2E3D4C5B6A', name: 'iPhone 16e', platform: 'ios', osVersion: 'iOS 26.0', type: 'iPhone-16e'},
    iphonese: {id: '1A2B3C4D-2222-4C55-9A0B-1F2E3D4C5B6A', name: 'iPhone SE (3rd generation)', platform: 'ios', osVersion: 'iOS 26.0', type: 'iPhone-SE-3rd-generation'},
    ipadpro: {id: '9C2D7E1B-4F3A-4B8C-8D9E-0A1B2C3D4E5F', name: 'iPad Pro 13-inch (M5)', platform: 'ios', osVersion: 'iOS 26.0', type: 'iPad-Pro-13-inch-M5'},
    ipad9: {id: '9C2D7E1B-3333-4B8C-8D9E-0A1B2C3D4E5F', name: 'iPad (9th generation)', platform: 'ios', osVersion: 'iOS 18.6', type: 'iPad-9th-generation'},
    pixel9: {id: 'emulator-5554', name: 'Pixel_9_API_36', platform: 'android', osVersion: 'Android 16', avd: 'hw.device.name=pixel_9\nhw.lcd.width=1080\nhw.lcd.height=2424\nhw.lcd.density=420'},
    pixelfold: {id: 'emulator-5556', name: 'Pixel_9_Pro_Fold_API_35', platform: 'android', osVersion: 'Android 15', avd: 'hw.device.name=pixel_9_pro_fold\nhw.sensor.hinge=yes'},
    pixeltablet: {id: 'emulator-5558', name: 'Pixel_Tablet_API_35', platform: 'android', osVersion: 'Android 15', avd: 'hw.device.name=pixel_tablet\nhw.lcd.width=2560\nhw.lcd.height=1600\nhw.lcd.density=320'},
    centrepunch: {id: 'emulator-5560', name: 'Centre_Punch_Phone_API_35', platform: 'android', osVersion: 'Android 15', avd: 'hw.device.name=SM-S921B\nhw.device.manufacturer=Samsung\nhw.lcd.width=1080\nhw.lcd.height=2340'},
    wear: {id: 'emulator-5562', name: 'Wear_OS_Large_Round_API_34', platform: 'android', osVersion: 'Android 14', avd: 'hw.device.name=wearos_large_round\ntag.id=android-wear\nhw.lcd.width=454\nhw.lcd.height=454'},
    tv: {id: 'emulator-5564', name: 'Television_1080p_API_34', platform: 'android', osVersion: 'Android 14', avd: 'hw.device.name=tv_1080p\ntag.id=google-tv\nhw.lcd.width=1920\nhw.lcd.height=1080'},
    auto: {id: 'emulator-5566', name: 'Automotive_1024p_API_34', platform: 'android', osVersion: 'Android 14', avd: 'hw.device.name=automotive_1024p_landscape\ntag.id=android-automotive\nhw.lcd.width=1408\nhw.lcd.height=792'},
    unknown: {id: 'emulator-5568', name: 'Acme_X1_API_35', platform: 'android', osVersion: 'Android 15', avd: 'hw.device.name=acme_x1\nhw.lcd.width=1200\nhw.lcd.height=2640\nhw.lcd.density=480'},
  };
  const key = OPTS.deviceKey ?? (mode === 'tablet' ? 'ipadpro' : mode === 'android' ? 'pixel9' : 'iphone17pro');
  const frames = () => window.__shots?.deviceFrames;
  const frameOf = (fixture) => { const f = frames(); if (!f) return undefined; return fixture.platform === 'ios' ? f.iosFrame(`com.apple.CoreSimulator.SimDeviceType.${fixture.type}`, fixture.name) : f.androidFrame(f.parseIni(fixture.avd), fixture.name); };
  const form = (frame) => frame?.form === 'tablet' ? 'tablet' : frame?.form === 'foldable' ? 'foldable' : 'phone';
  const info = (k, fixture) => { const frame = frameOf(fixture); return {id: fixture.id, name: fixture.name, platform: fixture.platform, osVersion: fixture.osVersion, state: k === key && mode !== 'off' ? 'booted' : k === 'iphone17pro' || k === 'pixel9' ? 'booted' : 'shutdown', formFactor: form(frame), ...(frame ? {frame} : {})}; };
  const list = () => ({devices: mode === 'empty' ? [] : Object.entries(FIXTURES).map(([k, fixture]) => info(k, fixture)), errors: [], checkedAt: Date.now()});
  const pick = FIXTURES[key];
  const sessionList = () => {
    if (!['live', 'agent', 'tablet', 'android', 'error', 'starting'].includes(mode) || !pick) return [];
    const device = info(key, pick);
    return [{deviceId: pick.id, name: pick.name.replace(/_/g, ' '), platform: pick.platform, formFactor: device.formFactor, ...(device.frame ? {frame: device.frame} : {}), ...(mode === 'agent' ? {chatId: activeChatId} : {}), openedBy: mode === 'agent' ? 'agent' : 'user', control: 'agent', state: mode === 'error' ? 'error' : mode === 'starting' ? 'starting' : 'live', ...(mode === 'error' ? {error: 'No video arrived from the device. Reconnect to try again.'} : {}), inputReady: mode !== 'starting', openedAt: Date.now() - 60_000}];
  };
  Object.assign(handlers, {
    'devices.setup': setup, 'devices.list': list, 'devices.sessions': sessionList,
    'devices.configure': setup, 'devices.installHelper': setup, 'devices.view': ({active}) => { if (active && mode !== 'error' && mode !== 'starting') pump(); return null; },
    'devices.open': ({id}) => sessionList().find(x => x.deviceId === id) ?? sessionList()[0], 'devices.close': () => null, 'devices.button': () => null, 'devices.rotate': () => null, 'devices.control': ({owner}) => ({...sessionList()[0], control: owner}),
  });

  // --- Screens: an iOS-style home screen, an Android launcher, a watch face, a TV home and a car dashboard ----------
  const PALETTE = ['#e6624f', '#f0a33b', '#f2cf4a', '#5cbf72', '#3fb3a8', '#4f9be8', '#6f72e8', '#a46be0', '#e0679d', '#8e9aa6', '#46c0de', '#f07f3c', '#7ac36a', '#d65a5a', '#5b7be0', '#c69a54'];
  const NAMES = ['Notes', 'Mail', 'Photos', 'Camera', 'Clock', 'Maps', 'Weather', 'Music', 'Files', 'Tasks', 'Wallet', 'Health', 'Books', 'Calendar', 'Podcasts', 'Settings', 'Taskboard', 'Calculator', 'Contacts', 'Messages', 'Phone', 'News', 'Store', 'Translate'];
  const glyph = (g, x, y, size, i, color = 'rgba(255,255,255,.92)') => {
    // Plain geometric glyphs: a circle, a bar stack, a triangle, a ring… (never anyone's icon).
    g.save(); g.fillStyle = color; g.strokeStyle = color; g.lineWidth = size * 0.07; const c = size / 2, r = size * 0.2;
    switch (i % 6) {
      case 0: g.beginPath(); g.arc(x + c, y + c, r, 0, Math.PI * 2); g.fill(); break;
      case 1: for (let k = 0; k < 3; k++) g.fillRect(x + size * 0.3, y + size * (0.32 + k * 0.13), size * 0.4, size * 0.07); break;
      case 2: g.beginPath(); g.moveTo(x + c, y + size * 0.3); g.lineTo(x + size * 0.7, y + size * 0.68); g.lineTo(x + size * 0.3, y + size * 0.68); g.closePath(); g.fill(); break;
      case 3: g.beginPath(); g.arc(x + c, y + c, r, 0, Math.PI * 2); g.stroke(); break;
      case 4: g.beginPath(); g.roundRect(x + size * 0.3, y + size * 0.3, size * 0.4, size * 0.4, size * 0.08); g.fill(); break;
      default: g.beginPath(); g.moveTo(x + size * 0.3, y + c); g.lineTo(x + c, y + size * 0.3); g.lineTo(x + size * 0.7, y + c); g.lineTo(x + c, y + size * 0.7); g.closePath(); g.fill();
    }
    g.restore();
  };
  const wallpaper = (g, w, h, stops) => { const sky = g.createLinearGradient(0, 0, w * 0.4, h); stops.forEach((c, i) => sky.addColorStop(i / (stops.length - 1), c)); g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.globalAlpha = 0.18; g.fillStyle = '#fff'; g.beginPath(); g.ellipse(w * 0.8, h * 0.25, w * 0.5, w * 0.35, 0.4, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; };
  const statusIcons = (g, right, y, s, android) => {
    g.fillStyle = '#fff';
    if (android) { // wifi wedge, cell wedge, upright battery
      g.beginPath(); g.moveTo(right - s * 3.2, y + s * 0.95); g.lineTo(right - s * 4.2, y + s * 0.15); g.lineTo(right - s * 2.2, y + s * 0.15); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(right - s * 1.6, y + s); g.lineTo(right - s * 1.6, y); g.lineTo(right - s * 2.5, y + s); g.closePath(); g.fill();
      g.fillRect(right - s * 0.8, y - s * 0.05, s * 0.55, s * 1.05);
    } else { // signal bars, wifi fan, landscape battery
      for (let k = 0; k < 4; k++) g.fillRect(right - s * 5.2 + k * s * 0.32, y + s * (0.75 - k * 0.22), s * 0.22, s * (0.25 + k * 0.22));
      g.beginPath(); g.moveTo(right - s * 3.0, y + s); g.arc(right - s * 3.0, y + s, s * 0.95, -Math.PI * 0.78, -Math.PI * 0.22); g.closePath(); g.fill();
      g.beginPath(); g.roundRect(right - s * 1.85, y + s * 0.12, s * 1.55, s * 0.8, s * 0.2); g.fill(); g.fillRect(right - s * 0.25, y + s * 0.38, s * 0.12, s * 0.3);
    }
  };
  const iosHome = (g, w, h, frame) => {
    const tablet = frame.form === 'tablet', homeButton = !!frame.home, u = Math.min(w, h) / 100;
    wallpaper(g, w, h, ['#24306e', '#5a3fa0', '#c86b8f', '#f2a77a']);
    // Status bar: time at the left, indicators at the right, clear of the island or notch in the middle.
    const sbY = homeButton ? u * 1.6 : tablet ? u * 1.6 : u * 4.2, fs = tablet ? u * 2.1 : u * 4.1;
    g.fillStyle = '#fff'; g.font = `600 ${fs}px -apple-system, Helvetica, Arial`; g.textBaseline = 'top';
    g.fillText('9:41', tablet || homeButton ? u * 3 : w * 0.12, sbY); statusIcons(g, w - (tablet || homeButton ? u * 3 : w * 0.09), sbY + fs * 0.05, fs * 0.8, false);
    const cols = tablet ? (w > h ? 8 : 6) : 4, size = tablet ? u * 9.5 : u * 15.5, gap = (w - cols * size) / (cols + 1), top = tablet ? u * 9 : homeButton ? u * 9 : u * 15;
    const rows = tablet ? 4 : 5;
    for (let i = 0; i < cols * rows; i++) {
      const x = gap + (i % cols) * (size + gap), y = top + Math.floor(i / cols) * (size + u * (tablet ? 7 : 8.5));
      g.fillStyle = PALETTE[i % PALETTE.length]; g.beginPath(); g.roundRect(x, y, size, size, size * 0.225); g.fill();
      glyph(g, x, y, size, i);
      g.fillStyle = '#fff'; g.font = `500 ${tablet ? u * 1.5 : u * 2.7}px -apple-system, Helvetica, Arial`; g.textAlign = 'center'; g.fillText(NAMES[i % NAMES.length], x + size / 2, y + size + u * 1.2); g.textAlign = 'start';
    }
    // Page dots, the frosted dock, the home indicator.
    const dockH = size + u * (tablet ? 3 : 5), dockY = h - dockH - (homeButton ? u * 2 : u * 4.5);
    g.fillStyle = 'rgba(255,255,255,.9)'; for (let k = 0; k < 3; k++) { g.globalAlpha = k ? 0.45 : 0.95; g.beginPath(); g.arc(w / 2 + (k - 1) * u * 2.4, dockY - u * 3, u * 0.75, 0, Math.PI * 2); g.fill(); } g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,255,255,.26)'; g.beginPath(); g.roundRect(tablet ? w * 0.3 : u * 3, dockY, tablet ? w * 0.4 : w - u * 6, dockH, tablet ? u * 3 : u * 8); g.fill();
    const dockN = 4, dockW = tablet ? w * 0.4 : w - u * 6, dx0 = tablet ? w * 0.3 : u * 3, dgap = (dockW - dockN * size) / (dockN + 1);
    for (let k = 0; k < dockN; k++) { const x = dx0 + dgap + k * (size + dgap), y = dockY + (dockH - size) / 2; g.fillStyle = PALETTE[(k * 5 + 3) % PALETTE.length]; g.beginPath(); g.roundRect(x, y, size, size, size * 0.225); g.fill(); glyph(g, x, y, size, k + 2); }
    if (!homeButton) { g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.roundRect(w / 2 - w * 0.17, h - u * 1.6, w * 0.34, u * 0.9, u * 0.45); g.fill(); }
  };
  const androidHome = (g, w, h, frame) => {
    const u = Math.min(w, h) / 100, wide = w > h * 0.9, tablet = frame.form === 'tablet';
    wallpaper(g, w, h, ['#123a37', '#24625a', '#7fae8e', '#e7d7a3']);
    const fs = u * (wide ? 2.6 : 3.6);
    g.fillStyle = '#fff'; g.font = `500 ${fs}px Roboto, Helvetica, Arial`; g.textBaseline = 'top'; g.fillText('9:30', u * 4.5, u * 2.2);
    // Status icons sit left of a corner camera, as Android lays them out around the cut-out.
    const cut = frame.cutout ?? {kind: 'none', x: 0.5};
    statusIcons(g, cut.kind === 'punch-side' && cut.x > 0.5 ? w * cut.x - u * 5 : w - u * 4.5, u * 2.4, fs * 0.85, true);
    // An at-a-glance line: date and weather in plain text.
    g.font = `400 ${u * (wide ? 3.2 : 5)}px Roboto, Helvetica, Arial`; g.fillText('Tue, Oct 14', u * 6, u * (wide ? 9 : 13));
    g.font = `400 ${u * (wide ? 2.2 : 3.4)}px Roboto, Helvetica, Arial`; g.globalAlpha = 0.85; g.fillText('☀  18°  ·  Light breeze', u * 6, u * (wide ? 13.5 : 20)); g.globalAlpha = 1;
    const cols = wide ? (tablet ? 7 : 6) : 4, size = u * (wide ? 9 : 14), gap = (w - cols * size) / (cols + 1), rowH = size + u * (wide ? 6 : 7), favTop = h - (wide ? u * 22 : u * 33), rowsTop = favTop - rowH * 2 - u * (wide ? 4 : 6);
    for (let i = 0; i < cols * 2; i++) {
      const x = gap + (i % cols) * (size + gap), y = rowsTop + Math.floor(i / cols) * rowH;
      g.fillStyle = PALETTE[(i * 3 + 1) % PALETTE.length]; g.beginPath(); g.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); g.fill(); glyph(g, x, y, size, i + 1);
      g.fillStyle = '#fff'; g.font = `400 ${u * (wide ? 1.9 : 2.8)}px Roboto, Helvetica, Arial`; g.textAlign = 'center'; g.fillText(NAMES[(i + 5) % NAMES.length], x + size / 2, y + size + u * 1.2); g.textAlign = 'start';
    }
    // Favourites row, the search pill, the gesture handle (or a tablet's taskbar).
    const favY = favTop;
    for (let i = 0; i < cols; i++) { const x = gap + i * (size + gap); g.fillStyle = PALETTE[(i * 7 + 2) % PALETTE.length]; g.beginPath(); g.arc(x + size / 2, favY + size / 2, size / 2, 0, Math.PI * 2); g.fill(); glyph(g, x, favY, size, i + 3); }
    const pillH = u * (wide ? 6.5 : 11), pillY = h - (wide ? u * 10 : u * 15);
    g.fillStyle = 'rgba(255,255,255,.88)'; g.beginPath(); g.roundRect(u * 5, pillY, w - u * 10, pillH, pillH / 2); g.fill();
    g.fillStyle = '#5f6b6a'; g.font = `400 ${pillH * 0.36}px Roboto, Helvetica, Arial`; g.fillText('Search', u * 5 + pillH * 0.55, pillY + pillH * 0.3);
    g.beginPath(); g.arc(w - u * 5 - pillH * 0.5, pillY + pillH / 2, pillH * 0.16, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.8)'; g.beginPath(); g.roundRect(w / 2 - u * 9, h - u * 2.4, u * 18, u * 0.9, u * 0.45); g.fill();
  };
  const watchFace = (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h); const u = w / 100;
    g.strokeStyle = '#3fb3a8'; g.lineWidth = u * 2.2; g.beginPath(); g.arc(w / 2, h / 2, w * 0.43, -Math.PI / 2, Math.PI * 0.9); g.stroke();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `300 ${u * 24}px Roboto, Helvetica, Arial`; g.fillText('10:09', w / 2, h * 0.46);
    g.font = `400 ${u * 6.5}px Roboto, Helvetica, Arial`; g.fillStyle = '#9fd9d2'; g.fillText('TUE 14', w / 2, h * 0.64);
    for (const [k, color] of [[-1, '#f0a33b'], [1, '#4f9be8']]) { g.fillStyle = color; g.beginPath(); g.arc(w / 2 + k * w * 0.18, h * 0.8, u * 4.5, 0, Math.PI * 2); g.fill(); }
    g.textAlign = 'start';
  };
  const tvHome = (g, w, h) => {
    const u = h / 100; g.fillStyle = '#0f1216'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.font = `500 ${u * 4}px Roboto, Helvetica, Arial`; g.textBaseline = 'top'; g.fillText('For you', u * 6, u * 6);
    ['Movies', 'Shows', 'Apps', 'Library'].forEach((t, i) => { g.fillStyle = i ? 'rgba(255,255,255,.12)' : '#e8eaed'; g.beginPath(); g.roundRect(u * (28 + i * 18), u * 5, u * 16, u * 6, u * 3); g.fill(); g.fillStyle = i ? '#e8eaed' : '#0f1216'; g.font = `500 ${u * 2.6}px Roboto, Helvetica, Arial`; g.fillText(t, u * (31 + i * 18), u * 6.6); });
    const hero = g.createLinearGradient(0, 0, w, 0); hero.addColorStop(0, '#2c4f7c'); hero.addColorStop(1, '#7a3f6e'); g.fillStyle = hero; g.beginPath(); g.roundRect(u * 6, u * 16, w - u * 12, u * 38, u * 2); g.fill();
    g.fillStyle = '#fff'; g.font = `600 ${u * 6}px Roboto, Helvetica, Arial`; g.fillText('Featured tonight', u * 12, u * 36);
    for (let r = 0; r < 2; r++) for (let i = 0; i < 6; i++) { g.fillStyle = PALETTE[(i * 3 + r * 5) % PALETTE.length]; g.beginPath(); g.roundRect(u * 6 + i * (w - u * 12) / 6, u * (60 + r * 20), (w - u * 12) / 6 - u * 2, u * 16, u * 1.5); g.fill(); }
  };
  const carHome = (g, w, h) => {
    const u = h / 100; g.fillStyle = '#111417'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1d2a26'; g.beginPath(); g.roundRect(u * 4, u * 4, w * 0.6, u * 78, u * 4); g.fill();
    g.strokeStyle = '#3c6b5d'; g.lineWidth = u * 1.5; for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(u * 4 + i * w * 0.1, u * 4); g.lineTo(u * 4 + i * w * 0.12 + u * 20, u * 82); g.stroke(); }
    g.strokeStyle = '#4f9be8'; g.lineWidth = u * 2.5; g.beginPath(); g.moveTo(w * 0.1, u * 70); g.quadraticCurveTo(w * 0.3, u * 30, w * 0.55, u * 20); g.stroke();
    g.fillStyle = '#1e2226'; g.beginPath(); g.roundRect(w * 0.64 + u * 2, u * 4, w * 0.36 - u * 6, u * 78, u * 4); g.fill();
    g.fillStyle = '#c69a54'; g.beginPath(); g.roundRect(w * 0.64 + u * 6, u * 10, u * 28, u * 28, u * 3); g.fill();
    g.fillStyle = '#fff'; g.font = `500 ${u * 5}px Roboto, Helvetica, Arial`; g.textBaseline = 'top'; g.fillText('Morning drive', w * 0.64 + u * 6, u * 44); g.globalAlpha = 0.7; g.font = `400 ${u * 3.6}px Roboto, Helvetica, Arial`; g.fillText('Playlist · 42 min', w * 0.64 + u * 6, u * 52); g.globalAlpha = 1;
    g.fillStyle = '#0b0d0f'; g.fillRect(0, u * 86, w, u * 14);
    for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(255,255,255,.8)'; glyph(g, w * 0.2 + i * w * 0.11, u * 87, u * 12, i, 'rgba(255,255,255,.8)'); }
  };
  const pictureFrame = () => {
    const device = info(key, pick), frame = device.frame;
    if (!frame) return null;
    return OPTS.folded && frame.folded ? frame.folded : frame;
  };
  const draw = () => {
    const frame = pictureFrame();
    const sw = frame ? frame.screen.width : 1179, sh = frame ? frame.screen.height : 2556;
    const k = Math.min(1, 1100 / Math.max(sw, sh)), w = Math.round(sw * k), h = Math.round(sh * k);
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    if (!frame || frame.os === 'ios') iosHome(g, w, h, frame ?? {form: 'phone'});
    else if (frame.form === 'watch-round' || frame.form === 'watch-square') watchFace(g, w, h);
    else if (frame.form === 'tv') tvHome(g, w, h);
    else if (frame.form === 'automotive') carHome(g, w, h);
    else androidHome(g, w, h, frame);
    return c.convertToBlob({type: 'image/jpeg', quality: 0.88});
  };
  const frameListeners = new Set();
  let pumping = false;
  const pump = () => {
    if (pumping) return; pumping = true;
    let n = 0;
    const tick = async () => {
      const blob = await draw(); const data = new Uint8Array(await blob.arrayBuffer());
      for (const listener of [...frameListeners]) listener({deviceId: pick.id, codec: 'jpeg', key: true, data});
      if (++n < 3) setTimeout(tick, 250);
    };
    void tick();
  };
  window.musterDevices = {onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); }, ack() {}, input() {}};
  // Perf probe: a steady stream of `count` frames at `fps` (one pre-encoded JPEG, as main forwards a helper's MJPEG).
  window.__devicePump = async (count, fps) => {
    const data = new Uint8Array(await (await draw()).arrayBuffer());
    for (let i = 0; i < count; i++) { for (const listener of [...frameListeners]) listener({deviceId: pick.id, codec: 'jpeg', key: true, data}); await new Promise(r => setTimeout(r, 1000 / fps)); }
  };
}
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
