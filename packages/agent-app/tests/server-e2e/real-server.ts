/**
 * Test-only harness for the real-server workflows (#804): starts a real Muster Server from packages/server (bin/muster-server, the
 * built dist/), on a temp data dir and a free loopback port, waits for /healthz, and seeds it through the server's own CLI and HTTP API.
 * Nothing here is used by the app. Logs go to MUSTER_SERVER_E2E_LOGS (CI uploads that folder when the job fails).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'server');
export const SERVER_BIN = join(SERVER_ROOT, 'bin', 'muster-server');
export const LOG_DIR = process.env.MUSTER_SERVER_E2E_LOGS ?? join(tmpdir(), 'muster-server-e2e-logs');
mkdirSync(LOG_DIR, { recursive: true });

/** One line in client.log: what the app's client did and what it got back, for reading a CI failure. */
export function clientLog(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`;
  appendFileSync(join(LOG_DIR, 'client.log'), line);
}

export const OWNER = { username: 'olivia', password: 'e2e-owner-password-1', name: 'Olivia Owner' };
export const MEMBER = { username: 'mel', password: 'e2e-member-password-1', name: 'Mel Member' };

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Every server process this run started: none outlives the test process, even when it is interrupted. */
const running = new Set<ChildProcess>();
process.once('exit', () => { for (const child of running) try { child.kill('SIGKILL'); } catch { /* already gone */ } });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(130));

export interface Seeded { orgName: string; projectId: string; projectName: string; memberId: string }

export class RealServer {
  readonly work: string;
  readonly dataDir: string;
  readonly home: string;
  port = 0;
  child: ChildProcess | null = null;
  seeded: Seeded | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: string;

  constructor(readonly name: string) {
    if (!existsSync(join(SERVER_ROOT, 'dist', 'muster-server.cjs'))) throw new Error('packages/server/dist is missing. Run `npm run test:server-e2e` (it builds), or build packages/agent-app and then packages/server.');
    this.work = mkdtempSync(join(process.env.MUSTER_E2E_TMP ?? tmpdir(), `muster-server-e2e-${name}-`));
    this.dataDir = join(this.work, 'data');
    this.home = join(this.work, 'home');
    mkdirSync(this.home, { recursive: true });
    this.log = join(LOG_DIR, `${name}-server.log`);
    // The server runs with an isolated HOME and none of this machine's provider credentials.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENAI|ANTHROPIC|CODEX|CLAUDE|GEMINI|OPENROUTER|MUSTER_SERVER)_/.test(k) && !/(_API_KEY|_TOKEN)$/.test(k)));
    this.env = { ...env, HOME: this.home, XDG_CONFIG_HOME: join(this.home, '.config'), CODEX_HOME: join(this.home, '.codex'), CLAUDE_CONFIG_DIR: join(this.home, '.claude') };
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}`; }

  cli(argv: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      const child = execFile(SERVER_BIN, [...argv, '--data-dir', this.dataDir], { env: this.env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        appendFileSync(this.log, `$ muster-server ${argv.join(' ')} → ${error ? (error as { code?: number }).code ?? 1 : 0}\n${stdout}${stderr}`);
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
      child.stdin?.end(input ?? '');
    });
  }
  private async cliJson<T>(argv: string[], input?: string): Promise<T> {
    const r = await this.cli([...argv, '--json'], input);
    if (r.code !== 0) throw new Error(`muster-server ${argv.join(' ')} exited ${r.code}: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout) as T;
  }

  /** `init` on a fresh data dir: the org name and its owner (the first person). */
  async init(orgName: string): Promise<void> {
    this.port = await freePort();
    const r = await this.cli(['init', '--username', OWNER.username, '--name', OWNER.name, '--org-name', orgName, '--port', String(this.port), '--password-stdin'], OWNER.password);
    if (r.code !== 0) throw new Error(`init failed: ${r.stderr || r.stdout}`);
  }

  /** `muster-server start` in the foreground (its output goes to <name>-server.log), then waits for GET /healthz to answer ok. */
  async start(): Promise<void> {
    if (this.child) throw new Error(`${this.name} is already running`);
    const out = createWriteStream(this.log, { flags: 'a' });
    out.write(`\n--- start ${new Date().toISOString()} on ${this.baseUrl}\n`);
    const child = spawn(SERVER_BIN, ['start', '--port', String(this.port), '--data-dir', this.dataDir], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.pipe(out, { end: false });
    child.stderr!.pipe(out, { end: false });
    running.add(child);
    child.on('exit', (code, signal) => { running.delete(child); out.write(`--- exited code=${code} signal=${signal}\n`); });
    this.child = child;
    await this.waitHealthy();
  }

  async waitHealthy(timeoutMs = 30_000): Promise<{ ok: boolean; version: string; runtime: string }> {
    const until = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < until) {
      if (this.child && this.child.exitCode !== null) throw new Error(`${this.name} exited (${this.child.exitCode}) before it was healthy. See ${this.log}`);
      try {
        const r = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(2000) });
        const body = await r.json() as { ok: boolean; version: string; runtime: string };
        if (r.ok && body.ok && body.runtime === 'running') return body;
        last = JSON.stringify(body);
      } catch (e) { last = (e as Error).message; }
      await sleep(150);
    }
    throw new Error(`${this.name} was not healthy within ${timeoutMs} ms (${last}). See ${this.log}`);
  }

  /** The server goes away at once, the way a crash or a pulled cable looks to the app. */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise(r => child.once('exit', r));
      child.kill('SIGKILL');
      await gone;
    }
  }
  /** A clean stop (SIGTERM; the server closes its sockets and databases). */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    await gone;
    clearTimeout(timer);
  }

  /**
   * Seeds through the server's own surfaces: the owner's token from POST /api/auth/token, a folder and a project over /rpc, a second
   * person by `muster-server invite` and POST /api/invites/:token/accept, and that person's project grant by `muster-server users grant`.
   */
  async seed(orgName: string, projectName: string): Promise<Seeded> {
    const tokenReply = await fetch(`${this.baseUrl}/api/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: OWNER.username, password: OWNER.password, name: 'e2e seed' }) });
    const { token } = await tokenReply.json() as { token: string };
    if (!token) throw new Error(`owner token: HTTP ${tokenReply.status}`);
    const rpc = async <T>(command: string, input: unknown): Promise<T> => {
      const r = await fetch(`${this.baseUrl}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ command, input }) });
      const body = await r.json() as { ok?: boolean; value?: T; error?: string };
      if (!r.ok || body.ok === false) throw new Error(`seed ${command}: HTTP ${r.status} ${body.error ?? ''}`);
      return body.value as T;
    };
    // A project works in a folder on the server: a small git repository, as an admin would register.
    const repo = join(this.work, 'repos', projectName.toLowerCase().replace(/\W+/g, '-'));
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'README.md'), `# ${projectName}\n`);
    await new Promise<void>((resolve, reject) => execFile('git', ['-C', repo, 'init', '-q'], e => e ? reject(e) : resolve()));
    const folder = await rpc<{ id: string }>('folder.add', { path: repo });
    const project = await rpc<{ id: string }>('project.create', { name: projectName, goal: `End-to-end checks for ${orgName}`, folderIds: [folder.id], primaryFolderId: folder.id });
    const invite = await this.cliJson<{ url: string }>(['invite', '--role', 'member', '--expires', '1d']);
    const inviteToken = invite.url.split('/invite/')[1]!;
    const accepted = await fetch(`${this.baseUrl}/api/invites/${inviteToken}/accept`, { method: 'POST', headers: { 'content-type': 'application/json', origin: this.baseUrl }, body: JSON.stringify({ username: MEMBER.username, password: MEMBER.password, displayName: MEMBER.name }) });
    if (accepted.status !== 200) throw new Error(`invite accept: HTTP ${accepted.status} ${await accepted.text()}`);
    const grant = await this.cli(['users', 'grant', MEMBER.username, '--project', project.id, '--role', 'editor']);
    if (grant.code !== 0) throw new Error(`grant: ${grant.stderr || grant.stdout}`);
    const users = await this.cliJson<Array<{ id: string; username: string }>>(['users', 'list']);
    const memberId = users.find(u => u.username === MEMBER.username)?.id;
    if (!memberId) throw new Error('seeded member is missing from users list');
    this.seeded = { orgName, projectId: project.id, projectName, memberId };
    return this.seeded;
  }

  /** init → start → healthy → seeded. */
  static async launch(name: string, orgName: string, projectName: string): Promise<RealServer> {
    const server = new RealServer(name);
    await server.init(orgName);
    await server.start();
    await server.seed(orgName, projectName);
    return server;
  }

  async dispose(): Promise<void> {
    await this.stop().catch(() => this.kill());
    if (!process.env.MUSTER_SERVER_E2E_KEEP) rmSync(this.work, { recursive: true, force: true });
  }
}
