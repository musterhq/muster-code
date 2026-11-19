/**
 * A small fake Multica server on a loopback port, for the Multica workflow tests (#890). It answers the routes Muster uses with the
 * shapes a real Multica server sends (checked against `multica … --output json` on a live server and server/internal/handler in
 * multica-ai/multica): `{"error": "..."}` errors, `X-Workspace-ID` for workspace-scoped routes, `Authorization: Bearer mul_…`, issue
 * lists as `{issues, total, limit, offset, has_more}`, projects as `{projects, total, has_more}`, labels as `{labels, total}`, comments,
 * agents, members and workspaces as plain arrays. The data is invented.
 *
 * Signing in on the server's own page (#893), the way Multica's web app signs in its command-line tool: `/login?cli_callback=…&cli_state=…`
 * checks the callback the way Multica's `validateCliCallback` does (http, and localhost, 127.0.0.1 or an RFC 1918 address), then sends the
 * browser to `<callback>?token=<sign-in token>&state=<cli_state>` (Multica's page does this after an email code or Google; here it is at
 * once). `POST /api/tokens` with that token makes a personal access token (`{name, expires_in_days}` in, `{id, name, token_prefix, token}`
 * out, as server/internal/handler/personal_access_token.go), `GET /api/tokens` lists them and `DELETE /api/tokens/:id` revokes one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

type Json = Record<string, any>;
export interface FakeCall { method: string; path: string; auth: string | null; workspace: string | null; body: Json | null }
export interface MulticaFake {
  origin: string; token: string; calls: FakeCall[];
  state: { me: Json; workspaces: Json[]; members: Json[]; agents: Json[]; projects: Json[]; issues: Json[]; comments: Json[]; labels: Json[] };
  /** Agents this person may not assign work to (Multica answers 403). */
  forbiddenAgents: Set<string>;
  /** Every /api route answers 302 to this address instead. */
  redirectTo: string | null;
  /** Sign-in tokens `/login` handed out, and the personal access tokens `POST /api/tokens` made (with what was asked). */
  sessions: string[]; issued: { id: string; name: string; expires_in_days: unknown; token: string; by: string; revoked: boolean }[];
  /** An older server: `/login` ignores `cli_callback` (false), or there is no `/api/tokens` (false). */
  cliCallback: boolean; tokensRoute: boolean;
  close(): Promise<void>;
}
export const WS_ACME = '42f2c2b1-0000-4e1f-aa9a-f5b4bdd98501';
export const WS_LAB = '7a1c0d22-0000-4c55-9b4b-0e6f2d3a9c10';
export const ME_ID = '7869b389-1eb9-44b1-8652-c21e1562e9dd';
export const BOB_ID = '2b1e0b1a-55aa-4c1e-9c3a-8f0f4b0c7d21';
export const AGENT_DEV = 'c26f09c2-6850-428d-8bf1-47cb79188d43';
export const AGENT_QA = '682c5678-bd9b-4b50-8d3f-a04ac0661e77';
export const PROJECT_WEB = '92627bec-8ff0-5814-b66c-7d8550661cf8';
const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
const CATEGORY: Record<string, string> = { backlog: 'unstarted', todo: 'unstarted', in_progress: 'started', in_review: 'started', blocked: 'started', done: 'done', cancelled: 'closed' };
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const at = (n: number) => new Date(Date.parse('2026-11-13T06:00:00Z') + n * 60_000).toISOString().replace('.000Z', 'Z');

function issue(n: number, title: string, fields: Json = {}): Json {
  const status = fields.status ?? 'todo';
  return {
    id: randomUUID(), workspace_id: WS_ACME, number: n, identifier: `ACME-${n}`, title, description: fields.description ?? null, status, status_category: CATEGORY[status] ?? 'unstarted', status_name: '',
    priority: fields.priority ?? 'none', assignee_type: fields.assignee_type ?? null, assignee_id: fields.assignee_id ?? null, creator_type: 'member', creator_id: ME_ID,
    parent_issue_id: null, project_id: fields.project_id ?? null, position: -n, stage: null, start_date: null, due_date: null, duplicate_of: null,
    labels: fields.labels ?? [], metadata: {}, properties: {}, revision: 1, created_at: at(n), updated_at: at(n), last_activity_at: at(n + 1),
  };
}

export function seed(): MulticaFake['state'] {
  const bug = { id: 'd0c0a3e1-1111-4b3c-8d2e-000000000001', workspace_id: WS_ACME, resource_type: 'issue', name: 'bug', description: '', color: '#e5484d', usage_count: 1, created_at: at(0) };
  const issues = [
    issue(1, 'Fix the login redirect', { status: 'in_review', priority: 'urgent', assignee_type: 'agent', assignee_id: AGENT_DEV, project_id: PROJECT_WEB, labels: [bug], description: 'After sign-in the app lands on /undefined.' }),
    issue(2, 'Write the release notes', { status: 'todo', priority: 'medium', assignee_type: 'member', assignee_id: ME_ID, project_id: PROJECT_WEB, description: 'Draft the notes for 1.4.' }),
    issue(3, 'Tidy the backlog', { status: 'backlog', priority: 'none' }),
  ];
  return {
    me: { id: ME_ID, name: 'Dana Founder', email: 'dana@acme.example', avatar_url: null, language: null, timezone: null, onboarded_at: at(0), onboarding_questionnaire: {}, profile_description: '', whats_new_seen_version: null },
    workspaces: [
      { id: WS_ACME, name: 'Acme', slug: 'acme', description: null, context: null, settings: {}, repos: [], issue_prefix: 'ACME', avatar_url: null, created_at: at(0), updated_at: at(0) },
      { id: WS_LAB, name: 'Lab', slug: 'lab', description: null, context: null, settings: {}, repos: [], issue_prefix: 'LAB', avatar_url: null, created_at: at(0), updated_at: at(0) },
    ],
    members: [
      { id: 'm-1', workspace_id: WS_ACME, user_id: ME_ID, role: 'owner', name: 'Dana Founder', email: 'dana@acme.example', avatar_url: null, created_at: at(0) },
      { id: 'm-2', workspace_id: WS_ACME, user_id: BOB_ID, role: 'member', name: 'Bob Builder', email: 'bob@acme.example', avatar_url: null, created_at: at(0) },
    ],
    agents: [
      { id: AGENT_DEV, workspace_id: WS_ACME, runtime_id: 'rt-1', runtime_bound: true, runtime_mode: 'local', runtime_availability: 'online', name: 'Dev Agent', description: 'Writes the code.', instructions: 'Ship small PRs.', avatar_url: null, status: 'working', model: 'executor', visibility: 'workspace', archived_at: null, archived_by: null, created_at: at(0), updated_at: at(0), owner_id: ME_ID, skills: [], custom_args: [] },
      { id: AGENT_QA, workspace_id: WS_ACME, runtime_id: 'rt-1', runtime_bound: true, runtime_mode: 'local', runtime_availability: 'online', name: 'QA Agent', description: 'Reviews the work.', instructions: 'Review like a skeptic.', avatar_url: null, status: 'idle', model: 'executor', visibility: 'workspace', archived_at: null, archived_by: null, created_at: at(0), updated_at: at(0), owner_id: ME_ID, skills: [], custom_args: [] },
    ],
    projects: [{ id: PROJECT_WEB, workspace_id: WS_ACME, title: 'Website', description: 'The marketing site.', icon: null, status: 'in_progress', priority: 'none', lead_type: null, lead_id: null, creator_type: null, creator_id: null, start_date: null, due_date: null, visibility: 'workspace', workflow_id: null, issue_count: 2, done_count: 0, resource_count: 0, created_at: at(0), updated_at: at(0) }],
    issues,
    comments: [{ id: randomUUID(), issue_id: issues[0]!.id, author_type: 'agent', author_id: AGENT_DEV, content: 'Opened a fix. [@Dana Founder](mention://member/' + ME_ID + ') please review.', type: 'comment', parent_id: null, attachments: [], reactions: [], resolved_at: null, resolved_by_id: null, resolved_by_type: null, revision: 1, source_task_id: null, created_at: at(5), updated_at: at(5) }],
    labels: [bug],
  };
}

/** Multica's own check of `cli_callback` (packages/views/auth/login-page.tsx `validateCliCallback`). */
function validCliCallback(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:') return false;
    const h = u.hostname;
    return h === 'localhost' || h === '127.0.0.1' || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^192\.168\./.test(h);
  } catch { return false; }
}
const send = (res: ServerResponse, status: number, value: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
const fail = (res: ServerResponse, status: number, error: string) => send(res, status, { error });
const readBody = (req: IncomingMessage) => new Promise<Json | null>(resolve => { let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) as Json : null); } catch { resolve(null); } }); });

export async function startMulticaFake(options: { token?: string; state?: MulticaFake['state'] } = {}): Promise<MulticaFake> {
  const token = options.token ?? `mul_${randomUUID().replace(/-/g, '')}`;
  const state = options.state ?? seed();
  const calls: FakeCall[] = [];
  const fake = { token, calls, state, forbiddenAgents: new Set<string>(), redirectTo: null as string | null, sessions: [], issued: [], cliCallback: true, tokensRoute: true } as unknown as MulticaFake;
  const accepted = (bearer: string) => bearer === token || fake.sessions.includes(bearer) || fake.issued.some(t => t.token === bearer && !t.revoked);
  const find = (ref: string) => state.issues.find(i => i.id === ref || i.identifier === ref);
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'), path = url.pathname, body = await readBody(req);
    const auth = req.headers.authorization ?? null, ws = (req.headers['x-workspace-id'] as string | undefined) ?? null;
    calls.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, auth, workspace: ws, body });
    if (fake.redirectTo && path.startsWith('/api/') && path !== '/api/config') { res.writeHead(302, { location: `${fake.redirectTo}${path}${url.search}` }); res.end(); return; }
    // Public routes.
    if (path === '/health') return send(res, 200, { status: 'ok', pid: 1, commit: '408f668dcf4e83812f31ffc09334148e816d3dcd', started_at: at(0) });
    if (path === '/healthz') return send(res, 404, '<!DOCTYPE html><html><body>404</body></html>', 'text/html; charset=utf-8');
    if (path === '/api/health') return send(res, 404, '404 page not found\n', 'text/plain; charset=utf-8');
    if (path === '/api/config') return send(res, 200, { cdn_domain: '', allow_signup: true, daemon_server_url: fake.origin, daemon_app_url: fake.origin, daemon_setup_target: 'self_host', vcs_integration_available: true, posthog_key: '', analytics_environment: 'production', feature_flags: { agents_agent_builder: true } });
    if (path === '/login') {
      const callback = url.searchParams.get('cli_callback'), cliState = url.searchParams.get('cli_state') ?? '';
      const page = '<!DOCTYPE html><html><body><h1>Sign in to Multica</h1></body></html>';
      if (callback === null || !fake.cliCallback) return send(res, 200, page, 'text/html; charset=utf-8');
      if (!validCliCallback(callback)) return send(res, 400, '<!DOCTYPE html><html><body>Invalid callback URL</body></html>', 'text/html; charset=utf-8');
      const session = `eyJhbGciOiJIUzI1NiJ9.${randomUUID().replace(/-/g, '')}.sig`;
      fake.sessions.push(session);
      res.writeHead(302, { location: `${callback}${callback.includes('?') ? '&' : '?'}token=${encodeURIComponent(session)}&state=${encodeURIComponent(cliState)}` }); res.end(); return;
    }
    if (!path.startsWith('/api/')) return send(res, 404, '404 page not found\n', 'text/plain; charset=utf-8');
    // Everything else needs the token (Multica's auth middleware answers in text/plain with a JSON body).
    if (!auth) return send(res, 401, '{"error":"missing authorization"}', 'text/plain; charset=utf-8');
    if (!auth.startsWith('Bearer ') || !accepted(auth.slice(7))) return send(res, 401, '{"error":"invalid token"}', 'text/plain; charset=utf-8');
    if (path.startsWith('/api/tokens') && !fake.tokensRoute) return send(res, 404, '404 page not found\n', 'text/plain; charset=utf-8');
    if (path === '/api/tokens' && req.method === 'POST') {
      if (!body || typeof body.name !== 'string' || !body.name) return fail(res, 400, 'name is required');
      const made = { id: randomUUID(), name: body.name, expires_in_days: body.expires_in_days, token: `mul_${randomUUID().replace(/-/g, '')}`, by: auth.slice(7), revoked: false };
      fake.issued.push(made);
      return send(res, 201, { id: made.id, name: made.name, token_prefix: made.token.slice(0, 12), expires_at: null, last_used_at: null, created_at: new Date().toISOString(), token: made.token });
    }
    if (path === '/api/tokens' && req.method === 'GET') return send(res, 200, fake.issued.filter(t => !t.revoked).map(t => ({ id: t.id, name: t.name, token_prefix: t.token.slice(0, 12), expires_at: null, last_used_at: null, created_at: at(0) })));
    const revoke = /^\/api\/tokens\/([^/]+)$/.exec(path);
    if (revoke && req.method === 'DELETE') { const t = fake.issued.find(x => x.id === revoke[1] && !x.revoked); if (!t) return fail(res, 404, 'token not found'); t.revoked = true; res.writeHead(204); res.end(); return; }
    if (path === '/api/me') return send(res, 200, state.me);
    if (path === '/api/workspaces' && req.method === 'GET') return send(res, 200, state.workspaces);
    // Workspace-scoped routes: the workspace comes from X-Workspace-ID (or the URL, for members).
    const members = /^\/api\/workspaces\/([^/]+)\/members$/.exec(path);
    const scope = members?.[1] ?? ws;
    if (!scope || !state.workspaces.some(w => w.id === scope)) return fail(res, 400, 'workspace_id is required');
    if (members) return send(res, 200, state.members.filter(m => m.workspace_id === scope));
    if (path === '/api/agents') return send(res, 200, state.agents.filter(a => a.workspace_id === scope));
    const agent = /^\/api\/agents\/([^/]+)$/.exec(path);
    if (agent) { const a = state.agents.find(x => x.id === agent[1] && x.workspace_id === scope); return a ? send(res, 200, a) : fail(res, 404, 'agent not found'); }
    if (path === '/api/labels') { const rows = state.labels.filter(l => l.workspace_id === scope); return send(res, 200, { labels: rows, total: rows.length }); }
    if (path === '/api/projects') { const rows = state.projects.filter(p => p.workspace_id === scope); return send(res, 200, { projects: rows, total: rows.length, has_more: false }); }
    if (path === '/api/issues' && req.method === 'GET') {
      const all = state.issues.filter(i => i.workspace_id === scope), limit = Math.min(100, Number(url.searchParams.get('limit') ?? 100)), offset = Number(url.searchParams.get('offset') ?? 0);
      const page = all.slice(offset, offset + limit);
      return send(res, 200, { issues: page, total: all.length, limit, offset, has_more: offset + page.length < all.length });
    }
    if (path === '/api/issues' && req.method === 'POST') {
      if (!body || typeof body.title !== 'string' || !body.title.trim()) return fail(res, 400, 'title is required');
      if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) return fail(res, 400, 'invalid priority');
      const ws0 = state.workspaces.find(w => w.id === scope)!;
      const n = Math.max(0, ...state.issues.filter(i => i.workspace_id === scope).map(i => i.number)) + 1;
      const created = { ...issue(n, body.title, { ...body }), workspace_id: scope, identifier: `${ws0.issue_prefix}-${n}`, description: body.description ?? null, labels: state.labels.filter(l => (body.label_ids ?? []).includes(l.id)) };
      state.issues.push(created);
      return send(res, 201, { ...created, pr_auto_complete_disabled: false });
    }
    const one = /^\/api\/issues\/([^/]+)(\/comments)?$/.exec(path);
    if (one) {
      const it = find(decodeURIComponent(one[1]!));
      if (!it || it.workspace_id !== scope) return fail(res, 404, 'issue not found');
      if (one[2] && req.method === 'GET') return send(res, 200, state.comments.filter(c => c.issue_id === it.id));
      if (one[2] && req.method === 'POST') {
        if (!body || typeof body.content !== 'string' || !body.content.trim()) return fail(res, 400, 'content is required');
        const c = { id: randomUUID(), issue_id: it.id, author_type: 'member', author_id: ME_ID, content: body.content, type: body.type ?? 'comment', parent_id: body.parent_id ?? null, attachments: [], reactions: [], resolved_at: null, resolved_by_id: null, resolved_by_type: null, revision: 1, source_task_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        state.comments.push(c);
        return send(res, 201, c);
      }
      if (req.method === 'GET') return send(res, 200, it);
      if (req.method === 'PUT') {
        const b = body ?? {};
        if (b.status !== undefined && !STATUSES.includes(b.status)) return fail(res, 400, `invalid status "${b.status}"`);
        if (b.priority !== undefined && !PRIORITIES.includes(b.priority)) return fail(res, 400, 'invalid priority');
        if (('assignee_type' in b) !== ('assignee_id' in b)) return fail(res, 400, 'assignee_type and assignee_id must be provided together');
        if (b.assignee_type === 'agent' && fake.forbiddenAgents.has(b.assignee_id)) return fail(res, 403, 'you do not have permission to assign work to this agent');
        if (b.assignee_type === 'member' && !state.members.some(m => m.user_id === b.assignee_id && m.workspace_id === scope)) return fail(res, 400, 'assignee_id does not refer to a member of this workspace');
        if (b.status !== undefined) { it.status = b.status; it.status_category = CATEGORY[b.status]; }
        if (b.priority !== undefined) it.priority = b.priority;
        if ('assignee_type' in b) { it.assignee_type = b.assignee_type; it.assignee_id = b.assignee_id; }
        it.revision++; it.updated_at = new Date().toISOString();
        return send(res, 200, it);
      }
    }
    return send(res, 404, '404 page not found\n', 'text/plain; charset=utf-8');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  fake.origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  fake.close = () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return fake;
}
