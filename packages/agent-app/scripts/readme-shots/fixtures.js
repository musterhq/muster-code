// Fictional demo data for the README screenshots: user "alex", project "taskboard".
// Everything here is invented. Injected into headless Chrome before the renderer loads.
(() => {
const HOME = '/Users/alex';
const ROOT = `${HOME}/code/taskboard`;
const INFRA = `${HOME}/code/taskboard-infra`;
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

const folders = [
  {id: 'f-taskboard', path: ROOT, name: 'taskboard'},
  {id: 'f-infra', path: INFRA, name: 'taskboard-infra'},
];
const projects = [
  {id: 'p-launch', name: 'Taskboard 0.4 launch', goal: 'Ship due-date reminders, pagination and the new board view by Friday.', folderIds: ['f-taskboard', 'f-infra'], primaryFolderId: 'f-taskboard'},
];
const chat = (id, title, extra = {}) => ({id, title, pinned: false, archived: false, draft: '', status: 'completed', updatedAt: ago(extra.age ?? 30), model: 'frontier-large', providerId: 'gateway', mode: 'agent', permissionMode: 'workspace', titleSource: 'generated', ...extra});
const chats = [
  chat('c-hero', 'Add due-date reminders to tasks', {folderId: 'f-taskboard', age: 2}),
  chat('c-flaky', 'Fix flaky session-expiry test', {folderId: 'f-taskboard', age: 45}),
  chat('c-paginate', 'Paginate GET /tasks, 50 per page', {folderId: 'f-taskboard', age: 1, status: 'running'}),
  chat('c-board', 'Board view: drag cards between columns', {folderId: 'f-taskboard', age: 190, pinned: true, pinOrder: 0}),
  chat('c-a11y', 'Audit keyboard focus in the task dialog', {folderId: 'f-taskboard', age: 60 * 26, unread: true}),
  chat('c-bucket', 'Add a staging bucket for attachments', {folderId: 'f-infra', age: 80}),
  chat('c-ci', 'Cache npm installs in CI', {folderId: 'f-infra', age: 60 * 30}),
  chat('c-notes', 'Draft the 0.4 release notes', {projectId: 'p-launch', folderId: 'f-taskboard', age: 15}),
  chat('c-plan', 'Plan the launch checklist', {projectId: 'p-launch', folderId: 'f-taskboard', age: 60 * 5}),
];

// ---- files ---------------------------------------------------------------------------------------
const files = {};
files['src/models/task.ts'] = {
before: `import { z } from 'zod';

export const TaskStatus = z.enum(['todo', 'doing', 'done']);

export const Task = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  status: TaskStatus.default('todo'),
  assigneeId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
});

export type Task = z.infer<typeof Task>;
`,
after: `import { z } from 'zod';

export const TaskStatus = z.enum(['todo', 'doing', 'done']);

export const Task = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  status: TaskStatus.default('todo'),
  assigneeId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
  dueAt: z.coerce.date().nullable().default(null),
  remindBeforeMinutes: z.number().int().min(5).max(10_080).default(60),
});

export type Task = z.infer<typeof Task>;

/** A task is due soon when its reminder window has opened and it is not done. */
export function isDueSoon(task: Task, now = new Date()): boolean {
  if (!task.dueAt || task.status === 'done') return false;
  const opensAt = task.dueAt.getTime() - task.remindBeforeMinutes * 60_000;
  return now.getTime() >= opensAt && now.getTime() < task.dueAt.getTime();
}
`};
files['src/jobs/reminders.ts'] = {before: '', after: `import { db } from '../db';
import { isDueSoon } from '../models/task';
import { notify } from '../notify';

/** Runs every minute. Sends one reminder per task, never twice. */
export async function sendDueReminders(now = new Date()): Promise<number> {
  const open = await db.tasks.findMany({ where: { status: { not: 'done' }, dueAt: { not: null }, remindedAt: null } });
  let sent = 0;
  for (const task of open) {
    if (!isDueSoon(task, now)) continue;
    await notify(task.assigneeId, \`“\${task.title}” is due \${formatRelative(task.dueAt!, now)}\`);
    await db.tasks.update({ where: { id: task.id }, data: { remindedAt: now } });
    sent++;
  }
  return sent;
}

function formatRelative(due: Date, now: Date): string {
  const minutes = Math.round((due.getTime() - now.getTime()) / 60_000);
  return minutes < 60 ? \`in \${minutes} min\` : \`in \${Math.round(minutes / 60)} h\`;
}
`};
files['web/src/components/TaskCard.tsx'] = {
before: `import type { Task } from '../api';
import { Avatar } from './Avatar';

export function TaskCard({ task }: { task: Task }) {
  return (
    <article className="task-card" data-status={task.status}>
      <h3>{task.title}</h3>
      <footer>
        <Avatar userId={task.assigneeId} />
      </footer>
    </article>
  );
}
`,
after: `import type { Task } from '../api';
import { Avatar } from './Avatar';
import { DueBadge } from './DueBadge';

export function TaskCard({ task }: { task: Task }) {
  return (
    <article className="task-card" data-status={task.status}>
      <h3>{task.title}</h3>
      <footer>
        {task.dueAt && <DueBadge dueAt={task.dueAt} done={task.status === 'done'} />}
        <Avatar userId={task.assigneeId} />
      </footer>
    </article>
  );
}
`};
files['src/api/tasks.ts'] = {before: `import { Router } from 'express';
import { db } from '../db';
import { Task } from '../models/task';

export const tasks = Router();

tasks.get('/', async (req, res) => {
  const rows = await db.tasks.findMany({ orderBy: { createdAt: 'desc' } });
  res.json(rows.map((row) => Task.parse(row)));
});

tasks.post('/', async (req, res) => {
  const input = Task.omit({ id: true, createdAt: true }).parse(req.body);
  const row = await db.tasks.create({ data: input });
  res.status(201).json(Task.parse(row));
});

tasks.patch('/:id', async (req, res) => {
  const input = Task.partial().parse(req.body);
  const row = await db.tasks.update({ where: { id: req.params.id }, data: input });
  res.json(Task.parse(row));
});
`};
files['src/api/tasks.ts'].after = files['src/api/tasks.ts'].before;
files['README.md'] = {before: `# taskboard

A small task tracker: a TypeScript API and a web board.

## Develop

\`\`\`sh
npm install
npm run dev      # api on :4000, web on :5173
npm test
\`\`\`
`};
files['README.md'].after = files['README.md'].before;
files['package.json'] = {before: `{
  "name": "taskboard",
  "private": true,
  "scripts": {
    "dev": "concurrently \\"npm:dev:*\\"",
    "dev:api": "tsx watch src/server.ts",
    "dev:web": "vite web",
    "test": "vitest run"
  }
}
`};
files['package.json'].after = files['package.json'].before;

const patch = (before, after) => {
  // Minimal line diff (LCS) -> one unified hunk with 3 lines of context per change region.
  const a = before ? before.replace(/\n$/, '').split('\n') : [], b = after.replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length, dp = Array.from({length: n + 1}, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]); else ops.push(['+', b[j++]]); }
  while (i < n) ops.push(['-', a[i++]]); while (j < m) ops.push(['+', b[j++]]);
  const hunks = []; let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { k++; continue; }
    let start = Math.max(0, k - 3), end = k;
    while (end < ops.length) { if (ops[end][0] !== ' ') { end++; continue; } let run = 0; while (end + run < ops.length && ops[end + run][0] === ' ') run++; if (end + run >= ops.length || run > 6) { end = Math.min(ops.length, end + 3); break; } end += run; }
    const slice = ops.slice(start, end);
    const oldStart = ops.slice(0, start).filter(o => o[0] !== '+').length + 1, newStart = ops.slice(0, start).filter(o => o[0] !== '-').length + 1;
    const oldLines = slice.filter(o => o[0] !== '+').length, newLines = slice.filter(o => o[0] !== '-').length;
    hunks.push(`@@ -${oldLines ? oldStart : 0},${oldLines} +${newStart},${newLines} @@\n` + slice.map(o => o[0] + o[1]).join('\n'));
    k = end;
  }
  return hunks.join('\n');
};
const stat = (p) => { let adds = 0, dels = 0; for (const line of p.split('\n')) { if (line.startsWith('+')) adds++; else if (line.startsWith('-')) dels++; } return {adds, dels}; };
const edited = ['src/models/task.ts', 'src/jobs/reminders.ts', 'web/src/components/TaskCard.tsx'];
const patches = Object.fromEntries(edited.map(path => [path, patch(files[path].before, files[path].after)]));

// ---- hero conversation ---------------------------------------------------------------------------
let seq = 0;
const item = (kind, text, extra = {}) => ({id: `h${++seq}`, chatId: 'c-hero', kind, text, status: 'completed', createdAt: ago(9 - seq * 0.25), ...extra});
const read = (paths, ms = 120) => item('tool', '', {data: {type: 'commandExecution', command: `sed -n '1,200p' ${paths[0]}`, commandActions: paths.map(path => ({type: 'read', path, name: path.split('/').at(-1)})), exitCode: 0, durationMs: ms}});
const TEST_OUTPUT = ` RUN  v3.2.4 ${ROOT}

 ✓ src/models/task.test.ts (9 tests) 14ms
 ✓ src/jobs/reminders.test.ts (6 tests) 31ms
 ✓ src/api/tasks.test.ts (12 tests) 188ms
 ✓ web/src/components/TaskCard.test.tsx (4 tests) 97ms

 Test Files  4 passed (4)
      Tests  31 passed (31)
   Start at  10:42:18
   Duration  1.62s (transform 412ms, setup 0ms, collect 1.10s, tests 330ms)
`;
const heroTimeline = [
  {id: 'h0a', chatId: 'c-hero', kind: 'user', text: 'Where do background jobs get scheduled in this repo?', status: 'completed', createdAt: ago(14)},
  {id: 'h0b', chatId: 'c-hero', kind: 'assistant', text: 'In [src/jobs/index.ts](src/jobs/index.ts). Each job registers with `every(\'1m\', fn)` and the server starts the scheduler after the database connects, so jobs never run against a cold pool.', status: 'completed', createdAt: ago(13.8)},
  item('user', 'Tasks need due dates with a reminder before they are due. Add `dueAt` to the model, a job that sends one reminder per task, and show a due badge on the board card. Keep the existing tests green.'),
  item('reasoning', 'The model lives in `src/models/task.ts` and is validated by a schema. I should check how jobs are scheduled and how notifications are sent before adding a reminders job, then look at the card component.'),
  read(['src/models/task.ts', 'src/api/tasks.ts']),
  item('tool', '', {data: {type: 'commandExecution', command: 'rg -n "schedule\\(|notify\\(" src', commandActions: [{type: 'search', query: 'schedule(|notify(', path: 'src'}], exitCode: 0, durationMs: 90}}),
  read(['src/jobs/index.ts', 'src/notify.ts', 'web/src/components/TaskCard.tsx']),
  item('reasoning', 'Jobs register in `src/jobs/index.ts` on a one-minute tick. `notify(userId, text)` already handles delivery. A `remindedAt` column prevents duplicate reminders.'),
  item('tool', '', {data: {type: 'fileChange', changes: [{path: 'src/models/task.ts', kind: {type: 'update'}, diff: patches['src/models/task.ts']}]}}),
  item('tool', '', {data: {type: 'fileChange', changes: [{path: 'src/jobs/reminders.ts', kind: {type: 'add'}, diff: files['src/jobs/reminders.ts'].after}]}}),
  item('tool', '', {data: {type: 'fileChange', changes: [{path: 'web/src/components/TaskCard.tsx', kind: {type: 'update'}, diff: patches['web/src/components/TaskCard.tsx']}]}}),
  item('tool', '', {data: {type: 'commandExecution', command: 'npm test', commandActions: [], exitCode: 0, durationMs: 4210, output: TEST_OUTPUT}}),
  item('assistant', `Due-date reminders are in, and all 31 tests pass.

- **Model**: \`dueAt\` and \`remindBeforeMinutes\` (default 60) on \`Task\`, plus \`isDueSoon()\` in [task.ts](src/models/task.ts).
- **Job**: [reminders.ts](src/jobs/reminders.ts) runs every minute and marks \`remindedAt\`, so each task is reminded once.
- **Board**: [TaskCard.tsx](web/src/components/TaskCard.tsx) shows a due badge when a date is set.

One follow-up: \`DueBadge\` doesn't exist yet. Want me to add it with "overdue" styling?`),
];

const simpleTimeline = (id, prompt, answer) => [
  {id: `${id}-1`, chatId: id, kind: 'user', text: prompt, status: 'completed', createdAt: ago(60)},
  {id: `${id}-2`, chatId: id, kind: 'assistant', text: answer, status: 'completed', createdAt: ago(59)},
];
const timelines = {
  'c-hero': heroTimeline,
  'c-flaky': simpleTimeline('c-flaky', 'The session-expiry test fails about 1 in 10 runs on CI. Find out why.', 'The test compared `Date.now()` twice across an `await`. I froze time with `vi.useFakeTimers()` and it passed 200 runs in a row.'),
  'c-paginate': simpleTimeline('c-paginate', 'Paginate GET /tasks with page tokens, 50 per page.', 'Working on it: the page token encodes `(createdAt, id)` so pages stay stable while tasks are added.'),
  'c-board': simpleTimeline('c-board', 'Let people drag cards between columns on the board.', 'Done. Dragging updates the status optimistically and rolls back if the PATCH fails.'),
  'c-a11y': simpleTimeline('c-a11y', 'Audit keyboard focus in the task dialog.', 'Focus now returns to the card that opened the dialog, and Escape closes it.'),
  'c-bucket': simpleTimeline('c-bucket', 'Add a staging bucket for attachments.', 'Added `attachments-staging` with a 30-day lifecycle rule.'),
  'c-ci': simpleTimeline('c-ci', 'Cache npm installs in CI.', 'The workflow now caches `~/.npm` keyed on the lockfile; installs dropped from 48s to 9s.'),
  'c-notes': simpleTimeline('c-notes', 'Draft the 0.4 release notes from the merged work.', 'Drafted `CHANGELOG.md` with Reminders, Pagination and Board view sections.'),
  'c-plan': simpleTimeline('c-plan', 'Plan the launch checklist.', 'Seven steps, from migrations to the announcement post.'),
};

// ---- providers -----------------------------------------------------------------------------------
const efforts = ['low', 'medium', 'high', 'xhigh'];
const providers = [
  {id: 'gateway', name: 'Team gateway (OpenAI-compatible)', available: true, status: 'ready', identityMasked: 'al••@taskboard.dev', source: 'config.toml', endpoint: 'https://llm.taskboard.dev/v1', checkedAt: ago(3),
    models: [
      {id: 'frontier-large', name: 'Frontier Large', efforts, defaultEffort: 'medium', contextWindow: 400000, images: true, toolSearch: true},
      {id: 'frontier-mini', name: 'Frontier Mini', efforts, defaultEffort: 'low', contextWindow: 400000, images: true, toolSearch: true},
      {id: 'coder-xl', name: 'Coder XL', efforts: ['medium'], contextWindow: 262144, images: false, toolSearch: false},
    ]},
  {id: 'subscription', name: 'Subscription sign-in', available: true, status: 'ready', identityMasked: 'a••x@example.com', source: 'Signed in', checkedAt: ago(10),
    models: [{id: 'agent-pro', name: 'Agent Pro', efforts, defaultEffort: 'high', contextWindow: 400000, images: true, toolSearch: true}]},
  {id: 'openrouter', name: 'API key: OPENROUTER_API_KEY', available: true, status: 'ready', identityMasked: 'sk-or-••••7f2a', apiKeyEnv: 'OPENROUTER_API_KEY', custom: true, endpoint: 'https://router.example.com/api/v1', checkedAt: ago(20),
    models: [{id: 'open-coder-v3', name: 'Open Coder v3', efforts: ['medium', 'high'], contextWindow: 163840, toolSearch: false}, {id: 'open-chat-2', name: 'Open Chat 2', contextWindow: 131072, toolSearch: false}]},
  {id: 'ollama', name: 'Local: Ollama', available: true, status: 'ready', identityMasked: 'localhost:11434', source: 'Detected', endpoint: 'http://localhost:11434/v1', checkedAt: ago(1),
    models: [{id: 'coder:30b', name: 'coder:30b', contextWindow: 32768, toolSearch: false}, {id: 'reasoner:20b', name: 'reasoner:20b', efforts: ['low', 'medium', 'high'], contextWindow: 131072, toolSearch: false}]},
  {id: 'lmstudio', name: 'Local: LM Studio', available: true, status: 'ready', identityMasked: 'localhost:1234', source: 'Detected', endpoint: 'http://localhost:1234/v1', checkedAt: ago(1),
    models: [{id: 'small-coder-24b', name: 'small-coder-24b', contextWindow: 131072, toolSearch: false}]},
];

// ---- memory --------------------------------------------------------------------------------------
const mem = (id, summary, kind, scope, extra = {}) => ({id, kind, summary, observedAt: ago(extra.age ?? 600), confidence: extra.confidence ?? 0.9, provenance: [extra.source ?? 'chat:c-hero'], scopes: [scope], redactionState: 'none', ...extra});
const PERSONAL = {kind: 'user', id: 'alex'}, FOLDER = {kind: 'folder', id: 'f-taskboard'};
const memories = [
  mem('m1', 'Prefers small, reviewable commits with a one-line summary and a short body.', 'preference', PERSONAL, {age: 60 * 24 * 6}),
  mem('m2', 'Uses pnpm for personal projects but npm in taskboard; never mix lockfiles.', 'preference', PERSONAL, {age: 60 * 24 * 3}),
  mem('m3', 'Tests freeze time with fake timers (vi.useFakeTimers()) instead of reading the real clock.', 'fact', FOLDER, {age: 45, source: 'chat:c-flaky'}),
  mem('m4', 'API validation uses the schemas in src/models; parse at the route boundary, never in the DB layer.', 'fact', FOLDER, {age: 60 * 5}),
  mem('m5', 'Background jobs register in src/jobs/index.ts and run on a one-minute tick.', 'fact', FOLDER, {age: 8}),
  mem('m6', 'Board cards must stay keyboard-reachable; focus returns to the card after the dialog closes.', 'decision', FOLDER, {age: 60 * 26, source: 'chat:c-a11y'}),
  mem('m7', 'Release notes go in CHANGELOG.md, grouped by feature, newest first.', 'decision', FOLDER, {age: 15, source: 'chat:c-notes'}),
];


// ---- skills, plugins, automations ----------------------------------------------------------------
const mono = (text, hue) => ({kind: 'monogram', text, hue});
const skill = (id, displayName, shortDescription, provenance, hue, pluginId) => ({id, name: id, displayName, shortDescription, provenance, path: `${HOME}/.muster/skills/${id}/SKILL.md`, readme: `# ${displayName}\n\n${shortDescription}`, readError: null, icon: mono(displayName.slice(0, 2), hue), ...(pluginId ? {pluginId} : {})});
const skills = [
  skill('release-notes', 'Release notes', 'Draft grouped release notes from merged work since the last tag.', 'user', 210),
  skill('api-endpoint', 'New API endpoint', 'Add a route with a Zod schema, a handler and tests, following taskboard conventions.', 'folder', 150),
  skill('db-migration', 'Database migration', 'Write a reversible migration and a backfill plan for a schema change.', 'folder', 30),
  skill('ui-review', 'UI review', 'Check a component for keyboard access, focus order and contrast.', 'user', 280),
  skill('commit-message', 'Commit message', 'Summarise staged changes as a one-line subject and a short body.', 'user', 330),
  skill('incident-notes', 'Incident notes', 'Turn a debugging session into a short incident write-up.', 'plugin', 0, 'taskboard-ops'),
];
const plugins = [
  {id: 'taskboard-ops', name: 'taskboard-ops', displayName: 'Taskboard ops', shortDescription: 'Deploy status, logs and on-call notes for the taskboard services.', version: '1.3.0', provenance: 'user', path: `${HOME}/.muster/plugins/taskboard-ops`, skills: ['incident-notes'], mcpServers: [{name: 'deploys', transport: 'remote'}, {name: 'logs', transport: 'local'}], apps: [], readError: null, category: 'Operations', icon: mono('Op', 0)},
  {id: 'design-tokens', name: 'design-tokens', displayName: 'Design tokens', shortDescription: 'Look up colour, spacing and type tokens while editing the web app.', version: '0.9.2', provenance: 'folder', path: `${ROOT}/.muster/plugins/design-tokens`, skills: [], mcpServers: [{name: 'tokens', transport: 'local'}], apps: [], readError: null, category: 'Design', icon: mono('Dt', 260)},
  {id: 'sql-console', name: 'sql-console', displayName: 'SQL console', shortDescription: 'Read-only queries against the local development database.', version: '2.0.1', provenance: 'user', path: `${HOME}/.muster/plugins/sql-console`, skills: [], mcpServers: [{name: 'postgres-readonly', transport: 'local'}], apps: [], readError: null, category: 'Data', icon: mono('Sq', 190)},
];
const auto = (id, name, prompt, schedule, summary, extra = {}) => ({id, name, prompt, target: {kind: 'new', folderId: 'f-taskboard', mode: 'agent'}, schedule, timezone: 'Europe/London', permissionMode: 'workspace', overlap: 'skip', catchUp: 'one', paused: false, createdAt: ago(60 * 24 * 14), updatedAt: ago(60 * 24 * 2), version: 3, summary, issues: [], ...extra});
const nextAt = (days, hh, mm) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
const automationRuns = [
  {id: 'r1', automationId: 'a-triage', scheduledFor: ago(60 * 14), trigger: 'schedule', status: 'completed', startedAt: ago(60 * 14), endedAt: ago(60 * 14 - 3), chatId: 'c-flaky', version: 3},
  {id: 'r2', automationId: 'a-deps', scheduledFor: ago(60 * 24 * 3), trigger: 'schedule', status: 'completed', startedAt: ago(60 * 24 * 3), endedAt: ago(60 * 24 * 3 - 6), version: 2},
  {id: 'r3', automationId: 'a-ci', scheduledFor: ago(60 * 5), trigger: 'repo', status: 'completed', startedAt: ago(60 * 5), endedAt: ago(60 * 5 - 4), version: 1},
];
const automations = [
  auto('a-triage', 'Morning test triage', 'Run the full test suite, and if anything fails, find the cause and propose a fix in a new chat.', {kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5]}, 'Weekdays at 08:30', {nextRunAt: nextAt(1, 8, 30), lastRun: automationRuns[0]}),
  auto('a-ci', 'Fix failing CI checks', 'A check failed on this branch. Read the log, reproduce locally and fix it.', {kind: 'repo', folderId: 'f-taskboard', events: ['check-failed']}, 'When a check fails', {lastRun: automationRuns[2]}),
  auto('a-deps', 'Weekly dependency review', 'List outdated dependencies, update patch versions and run the tests.', {kind: 'daily', time: '09:00', days: [1]}, 'Mondays at 09:00', {nextRunAt: nextAt(4, 9, 0), lastRun: automationRuns[1]}),
  auto('a-docs', 'Keep the API docs in sync', 'When route files change, update docs/api.md to match.', {kind: 'watch', folderId: 'f-taskboard'}, 'When files change in taskboard', {paused: true}),
];

window.__FX = {skills, plugins, automations, automationRuns, HOME, ROOT, INFRA, folders, projects, chats, files, patches, stat, timelines, providers, memories, TEST_OUTPUT, ago, edited};
})();
