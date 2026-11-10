/**
 * #147 phase 2: Muster's agent tools for a CLI that runs on an SSH host. The tools stay on this computer: each run's MCP
 * servers (browser, ask_user, canvases, office…) are started here, exactly as for a local run, with their own per-chat
 * tokens. The CLI on the host starts a small relay script instead of each server; the relay connects to 127.0.0.1:<port> on
 * the host, which ssh forwards (`-R`) to this listener, and sends one line naming the run's token and the server. This side
 * then starts the real server and joins its stdin and stdout to the connection.
 *
 * The listener binds 127.0.0.1 only. A token is 32 random bytes, made per run and forgotten when the run ends; a connection
 * whose first line does not name a live token and one of that run's servers is closed without starting anything.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { launcherSpec } from '../launcher-script.ts';
import { killOwned } from '../owned-process.ts';

export interface RelayServerSpec { command: string; args?: string[]; env?: Record<string, string> }
interface RelayRun { chatId: string; servers: Record<string, RelayServerSpec>; sockets: Set<Socket>; children: Set<ChildProcess> }

const HELLO = /^MUSTER-RELAY 1 ([0-9a-f]{64}) ([A-Za-z0-9_-]{1,64})$/;
const MAX_CONNECTIONS_PER_RUN = 32, HELLO_TIMEOUT_MS = 5_000;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export class ToolRelay {
  private server?: Server;
  private starting?: Promise<number>;
  /** By the token's SHA-256, so a lookup never compares secrets byte by byte. */
  private runs = new Map<string, RelayRun>();
  private disposed = false;

  /** Starts the listener once; resolves to its port on 127.0.0.1. */
  start(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error('Muster is closing.'));
    const address = this.server?.address();
    if (address && typeof address === 'object') return Promise.resolve(address.port);
    this.starting ??= new Promise<number>((resolve, reject) => {
      // Half-open: a relay that has sent everything (stdin ended) still gets the server's last answers.
      const server = createServer({ allowHalfOpen: true }, socket => this.accept(socket));
      server.once('error', error => { this.starting = undefined; reject(error); });
      server.listen(0, '127.0.0.1', () => { this.server = server; this.starting = undefined; resolve((server.address() as { port: number }).port); });
    });
    return this.starting;
  }

  /** Registers one run's servers; the token goes to the host only in the CLI's environment. */
  open(chatId: string, servers: Record<string, RelayServerSpec>): { token: string; close(): void } {
    const token = randomBytes(32).toString('hex'), key = digest(token);
    const run: RelayRun = { chatId, servers, sockets: new Set(), children: new Set() };
    this.runs.set(key, run);
    return { token, close: () => { if (this.runs.get(key) !== run) return; this.runs.delete(key); this.end(run); } };
  }
  /** How many runs hold a live token (tests). */
  get openRuns(): number { return this.runs.size; }

  private end(run: RelayRun) {
    for (const child of run.children) killOwned(child, 'SIGTERM');
    for (const socket of run.sockets) socket.destroy();
    run.children.clear(); run.sockets.clear();
  }

  private accept(socket: Socket) {
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0), done = false;
    const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS); timer.unref?.();
    const onData = (chunk: Buffer) => {
      if (done) return;
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end < 0) { if (buffered.length > 512) socket.destroy(); return; }
      done = true; clearTimeout(timer); socket.off('data', onData); socket.pause();
      const match = HELLO.exec(buffered.subarray(0, end).toString('latin1').replace(/\r$/, ''));
      const run = match ? this.runs.get(digest(match[1]!)) : undefined, spec = run && match ? run.servers[match[2]!] : undefined;
      if (!run || !spec || !Object.hasOwn(run.servers, match![2]!) || run.sockets.size >= MAX_CONNECTIONS_PER_RUN) { socket.destroy(); return; }
      this.bridge(run, socket, spec, buffered.subarray(end + 1));
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clearTimeout(timer));
  }

  /** Starts the server here, as a local run would, and joins it to the connection. */
  private bridge(run: RelayRun, socket: Socket, spec: RelayServerSpec, rest: Buffer) {
    const launch = spec.args ? { command: spec.command, args: spec.args } : { args: [] as string[], ...launcherSpec(spec.command) };
    let child: ChildProcess;
    try { child = spawn(launch.command, launch.args ?? [], { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch { socket.destroy(); return; }
    run.sockets.add(socket); run.children.add(child);
    const close = () => { run.sockets.delete(socket); run.children.delete(child); socket.destroy(); if (child.exitCode === null && child.signalCode === null) killOwned(child, 'SIGTERM'); };
    // The server ended: its output has been written (`close` follows the end of its stdout), so the connection ends after it.
    child.on('error', close); child.on('close', () => { socket.end(); setTimeout(close, 1_000).unref?.(); });
    child.stdin?.on('error', () => undefined);
    if (rest.length) child.stdin?.write(rest);
    socket.pipe(child.stdin!); child.stdout!.pipe(socket);
    socket.on('close', close);
    socket.resume();
  }

  dispose() {
    this.disposed = true;
    for (const run of this.runs.values()) this.end(run);
    this.runs.clear(); this.server?.close(); this.server = undefined;
  }
}

/**
 * The relay the host's CLI starts as each Muster MCP server (`relay <server>`). It holds no secret: the port and the run's
 * token arrive in its environment (MUSTER_RELAY_PORT, MUSTER_RELAY_TOKEN). It joins stdin and stdout to 127.0.0.1:<port>
 * with node, python3 or nc, whichever the host has, after sending the hello line.
 */
export const RELAY_SCRIPT = `#!/bin/sh
# Muster tool relay (#147). An agent CLI on this host starts it as one of Muster's MCP servers. It joins the server's stdin and
# stdout to Muster on the person's computer through ssh's reverse forward on 127.0.0.1:$MUSTER_RELAY_PORT. It holds no secret.
name=$1
token=$MUSTER_RELAY_TOKEN
case $token in ''|*[!0-9a-f]*) token=$MUSTER_RELAY_TOKEN_CONFIG ;; esac
case $token in ''|*[!0-9a-f]*) echo "muster relay: this run has no token; start it from Muster" >&2; exit 2 ;; esac
case $MUSTER_RELAY_PORT in ''|*[!0-9]*) echo "muster relay: no port" >&2; exit 2 ;; esac
case $name in ''|*[!A-Za-z0-9_-]*) echo "muster relay: bad server name" >&2; exit 2 ;; esac
MUSTER_RELAY_TOKEN=$token; export MUSTER_RELAY_TOKEN
if command -v node >/dev/null 2>&1; then
exec node -e '
const net = require("net"), [port, name] = process.argv.slice(1);
const s = net.connect(Number(port), "127.0.0.1", () => { s.write("MUSTER-RELAY 1 " + process.env.MUSTER_RELAY_TOKEN + " " + name + "\\n"); process.stdin.pipe(s); });
s.pipe(process.stdout);
s.on("error", e => { process.stderr.write("muster relay: " + e.message + "\\n"); process.exit(1); });
s.on("close", () => process.exit(0));
' "$MUSTER_RELAY_PORT" "$name"
elif command -v python3 >/dev/null 2>&1; then
exec python3 -c '
import os, socket, sys, threading
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])))
s.sendall(("MUSTER-RELAY 1 %s %s\\n" % (os.environ["MUSTER_RELAY_TOKEN"], sys.argv[2])).encode())
def up():
    while True:
        d = os.read(0, 65536)
        if not d: break
        s.sendall(d)
    try: s.shutdown(socket.SHUT_WR)
    except OSError: pass
threading.Thread(target=up, daemon=True).start()
out = sys.stdout.buffer
while True:
    d = s.recv(65536)
    if not d: break
    out.write(d); out.flush()
' "$MUSTER_RELAY_PORT" "$name"
elif command -v nc >/dev/null 2>&1; then
{ printf 'MUSTER-RELAY 1 %s %s\\n' "$token" "$name"; exec cat; } | exec nc 127.0.0.1 "$MUSTER_RELAY_PORT"
else
echo "muster relay: this host needs node, python3 or nc for Muster's tools" >&2; exit 2
fi
`;
