/**
 * #147 phase 2: agents that run on an SSH host. A chat whose folder is `ssh://host/path` runs its provider CLI (Claude Code,
 * Codex's app-server, an ACP agent) on the host, inside that folder, over the host's shared ssh connection (`ssh -T`). The
 * adapters start CLIs through spawnOwned, so this module registers a `muster-remote:<id>` command whose spawn is that ssh
 * session and whose kill ends the process group on the host: the event streams, approvals, steering, Stop and resume of a
 * local run all work unchanged.
 *
 * Nothing is installed on the host. The CLI must already be there (found with `command -v`, also in the usual install
 * folders and the login shell's PATH), and it signs in with the host's own login. Muster writes one file on the host: the
 * tool relay script (no secret in it) in a private folder, `~/.muster-remote` (0700), next to the run's process-group file.
 *
 * The CLI's environment comes over the ssh channel, never the command line: the session's first stdin lines are
 * `NAME=value` pairs, read by the remote shell before it starts the CLI. Only the agent's git identity, the run's relay
 * token (Claude Code reads it for its MCP servers) and, when the person chose it for this host, the provider key Muster holds
 * are sent. Nothing secret is written on the host.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { RemoteHost } from '../../shared/domains/remote-protocol.ts';
import type { McpServerSpec, RemoteRun } from '../adapters/types.ts';
import { mcpServersFromOverrides } from '../adapters/shared.ts';
import { registerRemoteCommand } from '../owned-process.ts';
import type { RemoteHub } from './hub.ts';
import { shq, sshBinary, sshEnvironment } from './ssh.ts';
import { RELAY_SCRIPT, type ToolRelay } from './tool-relay.ts';

/** The private folder on the host, relative to its $HOME. */
export const REMOTE_DIR = '.muster-remote';

/** Muster's tool servers that act on this computer itself, so a run on a host never gets them. */
export const LOCAL_ONLY_TOOL_SERVERS = ['muster_computer', 'muster_device', 'muster_terminal', 'muster_background', 'muster_sandbox'] as const;

/** The routes that can run on a host, by driver, with the CLI each one needs there. */
export interface RemoteCli { name: string; label: string; install: string; signIn: string; key?: { env: string; label: string } }
export function remoteCli(route: { driver?: string; name: string; acp?: { command: string; preset?: string } }, installHint?: string): RemoteCli | null {
  if (route.driver === 'claude-code-cli') return { name: 'claude', label: 'Claude Code', install: 'Install it on the host yourself (for example `npm install -g @anthropic-ai/claude-code`)', signIn: 'run `claude` once in the folder’s terminal and sign in', key: { env: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' } };
  if (route.driver === 'codex-app-server') return { name: 'codex', label: 'Codex', install: 'Install it on the host yourself (for example `npm install -g @openai/codex`)', signIn: 'run `codex login` in the folder’s terminal', key: { env: 'OPENAI_API_KEY', label: 'OpenAI API key' } };
  if (route.driver === 'acp-agent' && route.acp?.command) {
    const command = route.acp.command.trim(), name = command.replace(/^.*[\\/]/, '');
    if (!/^[A-Za-z0-9._+-]{1,100}$/.test(name)) return null;
    return { name, label: route.name, install: installHint ? `Install it on the host yourself: ${installHint.replace(/\.$/, '')}` : `Install \`${name}\` on the host yourself`, signIn: `sign in to ${route.name} on the host` };
  }
  return null;
}

/**
 * Prepares the host: the private folder, the relay script (rewritten only when it changed), leftover processes of this
 * chat's earlier runs (a dropped connection leaves a CLI without a terminal running), and where the CLI is.
 * $1 relay script, $2 CLI name, $3 chat id. Prints `home <dir>`, `cli <path>` or `cli-missing`, `helper <name>`.
 */
const PREPARE = `
d="$HOME/${REMOTE_DIR}"
if [ -L "$d" ]; then echo "muster: $d is a link; remove it" >&2; exit 3; fi
umask 077; mkdir -p "$d" && chmod 700 "$d" || exit 3
f="$d/relay"
if [ "$(cat "$f" 2>/dev/null)" != "$1" ]; then printf '%s\\n' "$1" > "$f.$$" && chmod 700 "$f.$$" && mv -f "$f.$$" "$f" || exit 3; fi
for p in "$d"/run-"$3"-*.pid; do
  [ -f "$p" ] || continue; pg=$(cat "$p" 2>/dev/null)
  case $pg in ''|*[!0-9]*) ;; *) [ "$pg" -gt 1 ] && kill -s KILL -- "-$pg" 2>/dev/null ;; esac
  rm -f "$p"
done
printf 'home %s\\n' "$HOME"
PATH="$PATH:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.volta/bin:$HOME/.claude/local:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin"
for n in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$n" ] && PATH="$PATH:$n"; done
c=$(command -v -- "$2" 2>/dev/null)
case $c in /*) ;; *) c=$("\${SHELL:-/bin/sh}" -lc 'command -v -- "$0"' "$2" 2>/dev/null | tail -n 1) ;; esac
case $c in /*) printf 'cli %s\\n' "$c" ;; *) echo cli-missing ;; esac
for h in node python3 nc; do if command -v "$h" >/dev/null 2>&1; then printf 'helper %s\\n' "$h"; break; fi; done
`;

/**
 * Starts the CLI in the folder. $1 folder, $2 CLI path, $3 process-group file name; the CLI's arguments follow. The
 * environment arrives as `NAME=value` lines on stdin up to an empty line (read byte by byte, so the rest of stdin is the
 * CLI's). The CLI runs as a child so the group file is removed when it ends; Stop signals the whole group.
 */
const BOOT = `
d=$1; cli=$2; g="$HOME/${REMOTE_DIR}/$3"; shift 3
cd "$d" 2>/dev/null || { echo "muster: the folder $d is not on this host any more" >&2; exit 97; }
while IFS= read -r kv; do [ -n "$kv" ] || break; export "$kv"; done
pg=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' '); case $pg in ''|*[!0-9]*) pg=$$ ;; esac
(umask 077; printf '%s\\n' "$pg" > "$g")
PATH="\${cli%/*}:$PATH"; export PATH
exec 3<&0
"$cli" "$@" <&3 3<&- &
child=$!
exec 3<&-
wait "$child"; s=$?
rm -f "$g"
exit $s
`;

/** Ends a run's process group on the host: $2 (INT or TERM; KILL goes straight to the end), up to five seconds, then KILL.
 *  $1 group file name. */
const KILL = `
g="$HOME/${REMOTE_DIR}/$1"; pg=$(cat "$g" 2>/dev/null)
case $pg in ''|*[!0-9]*) exit 0 ;; esac
[ "$pg" -gt 1 ] || exit 0
case $2 in INT|TERM) kill -s "$2" -- "-$pg" 2>/dev/null ;; esac
i=0; while [ $i -lt 5 ] && kill -0 -- "-$pg" 2>/dev/null; do sleep 1; i=$((i+1)); done
kill -s KILL -- "-$pg" 2>/dev/null
rm -f "$g"; exit 0
`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** What a CLI on a host may receive from the run's environment: the agent's git identity. Everything else stays here. */
const FORWARDED = /^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)$/;

export interface PreparedRemote {
  run: RemoteRun;
  /** The run's MCP servers become the relay on the host; returns the rewritten overrides and the run's relay handle. */
  tools(overrides: Record<string, unknown> | undefined, chatId: string): { overrides: Record<string, unknown>; dropped: string[]; close(): void };
  /** The local ssh of this run's CLI exited with 255: the connection dropped. */
  dropped(): boolean;
  dispose(): void;
}
export interface PrepareOptions {
  host: RemoteHost; root: string; chatId: string; cli: RemoteCli;
  /** The provider key Muster holds, passed for this run only when the person chose it for this host. */
  key?: { env: string; value: string };
  /** Claude Code reads the relay token from its own environment (its MCP config travels on the command line). */
  tokenInEnv?: boolean;
}

export class RemoteAgents {
  constructor(private hub: RemoteHub, private relay: ToolRelay) {}

  /** Connects, writes the relay script, finds the CLI and opens the tools' reverse forward. Rejects with a sentence. */
  async prepare(o: PrepareOptions): Promise<PreparedRemote> {
    const { host, cli } = o;
    await this.hub.ensure(host);
    const r = await this.hub.exec(host, PREPARE, [RELAY_SCRIPT.trimEnd(), cli.name, o.chatId], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`Muster could not prepare ${host.name} for the agent: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}.`);
    const lines = r.stdout.toString('utf8').split('\n'), field = (k: string) => lines.find(l => l.startsWith(`${k} `))?.slice(k.length + 1).trim();
    const home = field('home'), path = field('cli');
    if (!home || !home.startsWith('/')) throw new Error(`${host.name} did not report its home folder.`);
    if (!path) throw new Error(`${cli.label} is not installed on ${host.name}. ${cli.install}, sign in there (${cli.signIn}), then send again. Muster never installs anything on a host.`);
    const localPort = await this.relay.start(), remotePort = await this.hub.reverseForward(host, localPort);
    const relayPath = `${home}/${REMOTE_DIR}/relay`;
    let token: string | undefined, lastExit: number | null | undefined;
    const sessionArgs = await this.hub.sessionArgs(host, ['-T']);
    const hub = this.hub, groups = new WeakMap<ChildProcess, string>(), stopping = new WeakSet<ChildProcess>();
    const registration = registerRemoteCommand(randomUUID(), {
      spawn(args: string[], options: SpawnOptions): ChildProcess {
        const group = `run-${o.chatId}-${randomUUID()}.pid`;
        const command = `/bin/sh -c ${shq(BOOT)} muster ${[o.root, path, group, ...args].map(shq).join(' ')}`;
        const child = spawn(sshBinary(), [...sessionArgs, command], { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnvironment(), cwd: homedir(), detached: process.platform !== 'win32', windowsHide: true });
        groups.set(child, group);
        child.on('exit', code => { lastExit = code; });
        // The environment header: what the run may pass to the host, then an empty line. Values never hold a newline.
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(options.env ?? {})) if (FORWARDED.test(name) && typeof value === 'string') env[name] = value;
        if (o.tokenInEnv && token) env.MUSTER_RELAY_TOKEN = token;
        if (o.key) env[o.key.env] = o.key.value;
        const header = Object.entries(env).filter(([name, value]) => ENV_NAME.test(name) && !/[\0\r\n]/.test(value)).map(([name, value]) => `${name}=${value}\n`).join('');
        child.stdin?.on('error', () => undefined);
        child.stdin?.write(`${header}\n`);
        return child;
      },
      kill(child: ChildProcess, signal: NodeJS.Signals) {
        const group = groups.get(child);
        const local = () => { try { if (child.exitCode === null && child.signalCode === null) child.kill(signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'); } catch { /* gone */ } };
        if (signal === 'SIGKILL') local();
        if (!group || stopping.has(child)) return;
        stopping.add(child);
        // The process on the host ends first; its ssh session then ends by itself. A host that cannot be reached is let go.
        void hub.exec(host, KILL, [group, signal === 'SIGINT' ? 'INT' : signal === 'SIGKILL' ? 'KILL' : 'TERM'], { timeoutMs: 15_000 }).then(() => { setTimeout(local, 3_000).unref?.(); }, local);
      },
    });
    return {
      run: { host: host.name, root: o.root, command: registration.command },
      tools: (overrides, chatId) => {
        const servers = mcpServersFromOverrides(overrides), next: Record<string, unknown> = { ...overrides }, keep: Record<string, McpServerSpec> = {}, dropped: string[] = [];
        for (const name of Object.keys(servers)) {
          const spec = servers[name]!, local = (LOCAL_ONLY_TOOL_SERVERS as readonly string[]).includes(name);
          for (const key of Object.keys(next)) {
            const own = key.startsWith(`mcp_servers.${name}.`) || key.startsWith(`secret.mcp_servers.${name}.`);
            if (own && (local || /\.(?:command|args|env\.[^.]+)$/.test(key))) delete next[key];
          }
          if (local) { dropped.push(name); continue; }
          keep[name] = spec;
        }
        // The run's shell variables name files on this computer (the sudo helper, lent secrets): only the git identity goes.
        for (const key of Object.keys(next)) { const m = /^shell_environment_policy\.set\.(.+)$/.exec(key); if (m && !FORWARDED.test(m[1]!)) delete next[key]; }
        const handle = this.relay.open(chatId, keep); token = handle.token;
        for (const name of Object.keys(keep)) {
          next[`mcp_servers.${name}.command`] = relayPath;
          next[`mcp_servers.${name}.args`] = [name];
          next[`mcp_servers.${name}.env.MUSTER_RELAY_PORT`] = String(remotePort);
          next[`secret.mcp_servers.${name}.env.MUSTER_RELAY_TOKEN`] = handle.token;
        }
        return { overrides: next, dropped, close: () => { handle.close(); if (token === handle.token) token = undefined; } };
      },
      dropped: () => lastExit === 255,
      dispose: () => registration.dispose(),
    };
  }
}

/** Claude Code's `--mcp-config` for a run on a host: the relay servers as inline JSON, with no secret in it. The token
 *  stays in Claude Code's own environment; `${MUSTER_RELAY_TOKEN}` asks Claude Code to pass it on. */
export function inlineMcpConfig(servers: Record<string, McpServerSpec>): string {
  const clean = Object.fromEntries(Object.entries(servers).map(([name, spec]) => {
    const env = { ...spec.env }; delete env.MUSTER_RELAY_TOKEN;
    return [name, { command: spec.command, ...(spec.args ? { args: spec.args } : {}), env: { ...env, MUSTER_RELAY_TOKEN_CONFIG: '${MUSTER_RELAY_TOKEN}' } }];
  }));
  return JSON.stringify({ mcpServers: clean });
}

/** A failed run's words on a host: the CLI's own sign-in, a dropped connection. */
export function remoteFailure(message: string, o: { host: string; cli: RemoteCli; dropped: boolean }): string | undefined {
  if (o.dropped) return `The connection to ${o.host} dropped while ${o.cli.label} was working there, so the run was interrupted. Muster reconnects on the next use; send again to continue.`;
  if (/not logged in|not signed in|please run \/login|invalid api key|log ?in required|authentication(?: is)? required|unauthori[sz]ed|\b401\b|codex login|auth(?:entication)? (?:failed|required)|needs you to sign in/i.test(message))
    return `${o.cli.label} on ${o.host} is not signed in. Sign in on the host (${o.cli.signIn}), or choose to pass your key for this host in Settings › Environments › SSH workspaces, then send again.`;
  return undefined;
}
