/**
 * Local Docker-backed sandbox — a real, scope-owned isolated computer running
 * on THIS machine.
 *
 * ═══ WHY THIS FILE, NOT ANOTHER FRAMEWORK ═══
 *
 * `scoped-runtime.ts` already resolves a scope chain to a durable directory,
 * env allowlist, and tool policy — but it explicitly does NOT execute
 * anything (see its "THIS IS A SEAM, NOT A SANDBOX" banner). This module is
 * the executor that seam was built for: it takes a `ScopedRuntimeDescriptor`
 * and provisions a real Docker container bound to that scope's `workDir`,
 * runs commands inside it with bounded streaming output and correct
 * cancellation, and persists enough state next to the scope's own runtime
 * manifest to reattach after a controller restart.
 *
 * The provider contract (`SandboxHandle`, `SandboxExecResult`,
 * provision/run/stop/inspect shape) is adapted from QM's sandbox contract
 * (github.com/yc-software/qm, MIT licensed) at
 * `src/sandbox/sandbox.ts` / `src/sandbox/local-sandbox.ts` — field names and
 * responsibilities follow that prior art so a future remote provider (Fly,
 * AWS, etc.) can implement the same shape without a rewrite. The Docker
 * process-management code itself (container naming, exec streaming, pid-based
 * cancellation) is new, scoped to local-only use.
 *
 * ═══ WHAT THIS IS, HONESTLY ═══
 *
 * A local Docker container is process + namespace isolation on the SAME
 * kernel as the host, verified here as: local integration validation, not
 * hostile multitenant production isolation, not a cloud deployment, not a
 * separate macOS desktop. It never mounts the Docker socket, the host home
 * directory, or host credentials into the sandbox, and never runs
 * `--privileged`. Ownership is enforced by comparing the caller's scope
 * digest against the digest recorded at provision time — cross-scope
 * inspect/exec/stop is refused, not merely discouraged.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScopedRuntimeDescriptor } from "./scoped-runtime.js";

export const DEFAULT_SANDBOX_IMAGE = "node:24-bookworm-slim";
/** Defaults applied when a descriptor declares no resource limit; ceilings clamp a declared value. */
export const SANDBOX_DEFAULT_MEMORY_MIB = 512;
export const SANDBOX_DEFAULT_CPUS = 1;
export const SANDBOX_DEFAULT_PIDS = 256;
export const SANDBOX_MAX_PIDS = 4096;
const REGISTRY_FILE = "sandbox-registry.json";
const CONTAINER_PREFIX = "muster-sbx-";
const KILL_GRACE_MS = 1500;

export class SandboxOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxOwnershipError";
  }
}

/**
 * Same-owner policy drift: the scope still owns the sandbox, but its resolved
 * policy no longer matches the one the container was provisioned under (e.g.
 * networkAccess tightened after a `bridge` container was created). Reuse is
 * refused; the container and workspace are preserved for deliberate
 * remediation.
 */
export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

export class SandboxNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxNotFoundError";
  }
}

export class SandboxProviderError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "SandboxProviderError";
  }
}

export interface SandboxHandle {
  /** Deterministic docker container name for this scope's sandbox. */
  readonly id: string;
  /** `sha256:…` digest of the owning scope's policy — the ownership token. */
  readonly ownerDigest: string;
  readonly image: string;
  readonly createdAt: string;
}

interface SandboxRegistryEntry {
  readonly containerName: string;
  readonly ownerDigest: string;
  readonly image: string;
  readonly createdAt: string;
  /** Effective policy digest at provision time; absent only in legacy registries, which fail closed. */
  readonly policyDigest?: string;
}

export interface SandboxExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** -1 when killed before the process could report an exit code. */
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface SandboxExecOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Per-stream cap. Default 1 MiB — bounded so a runaway command can't grow memory unboundedly. */
  readonly maxBufferBytes?: number;
  readonly env?: Record<string, string>;
}

export interface SandboxInspectResult {
  readonly running: boolean;
  readonly exitCode: number | null;
}

export interface LocalDockerSandboxOptions {
  readonly dockerBin?: string;
  readonly image?: string;
}

/**
 * Ownership token: sha256 over the owning scope's kind+id (NOT
 * `policyDigest`, which hashes only envAllowlist/toolPolicy/limits and is
 * identical across two scopes sharing default grants — see
 * scoped-runtime.ts's `resolveScopedRuntime`). Two different scopes must
 * never produce the same ownerDigest.
 */
function ownerDigestOf(descriptor: ScopedRuntimeDescriptor): string {
  return `sha256:${createHash("sha256").update(`${descriptor.owner.kind}:${descriptor.owner.id}`).digest("hex")}`;
}

function containerNameFor(descriptor: ScopedRuntimeDescriptor): string {
  // workDir is already a deterministic, collision-resistant slug of the owner
  // scope (scoped-runtime.ts's sha256-prefixed slug); reuse it verbatim so a
  // sandbox name never has to be computed a second, possibly divergent, way.
  const slug = descriptor.workDir.split("/").filter(Boolean).pop() ?? randomUUID();
  return `${CONTAINER_PREFIX}${slug}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
}

/**
 * Registry lives in a CONTROL subdirectory that is never bind-mounted into
 * the container — `provision` only mounts `workDir/workspace`. If the
 * registry (or scoped-runtime's own `runtime-manifest.json`, a workDir
 * sibling) were reachable from inside the sandbox, a compromised process
 * could rewrite its own ownerDigest and forge past the ownership check.
 */
function controlDir(descriptor: ScopedRuntimeDescriptor): string {
  return join(descriptor.workDir, ".sandbox");
}

function mountDir(descriptor: ScopedRuntimeDescriptor): string {
  return join(descriptor.workDir, "workspace");
}

/** Resource flags for `docker run`, derived only from the descriptor (enforced by the kernel cgroup, not advisory). */
export function sandboxResourceArgs(descriptor: ScopedRuntimeDescriptor): string[] {
  const limits = descriptor.limits;
  const pids = Math.min(SANDBOX_MAX_PIDS, Math.max(1, Math.trunc(limits.maxProcesses ?? SANDBOX_DEFAULT_PIDS)));
  const memory = Math.max(6, Math.trunc(limits.memoryMib ?? SANDBOX_DEFAULT_MEMORY_MIB));
  const cpus = limits.cpus ?? SANDBOX_DEFAULT_CPUS;
  if (!Number.isFinite(cpus) || cpus <= 0) throw new SandboxProviderError(`Invalid cpu limit ${String(cpus)} for sandbox`);
  return ["--pids-limit", String(pids), "--memory", `${memory}m`, "--cpus", String(cpus)];
}

/**
 * Read-only bind mounts for versioned tools/skills. Each source must be an existing
 * host directory (never a file or a symlink, which could be re-pointed after the
 * digest was taken) and every target is validated again here, independent of
 * scoped-runtime, because this is the process that hands paths to Docker.
 */
export async function sandboxLayerMountArgs(descriptor: ScopedRuntimeDescriptor): Promise<string[]> {
  const args: string[] = [];
  for (const mount of descriptor.limits.readOnlyMounts ?? []) {
    if (!mount.source.startsWith("/") || /[\0\r\n,]/.test(mount.source)) throw new SandboxProviderError(`Read-only layer source ${mount.source} is not an absolute path`);
    if (!mount.target.startsWith("/") || /[\0\r\n,:=]/.test(mount.target) || mount.target === "/workspace" || mount.target.startsWith("/workspace/") || mount.target.split("/").includes("..")) {
      throw new SandboxProviderError(`Read-only layer target ${mount.target} is not allowed`);
    }
    const stat = await lstat(mount.source).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new SandboxProviderError(`Read-only layer source ${mount.source} is not a directory`);
    args.push("--mount", `type=bind,source=${mount.source},target=${mount.target},readonly`);
  }
  return args;
}

/**
 * Maps the resolved scope policy onto a Docker network mode. Fails closed:
 * `allowlist` has no Docker-native enforcement (needs an egress proxy), so it
 * gets `none` rather than silently granting full bridge access.
 */
function networkModeFor(descriptor: ScopedRuntimeDescriptor): string {
  return descriptor.limits.networkAccess === "unrestricted" ? "bridge" : "none";
}

/**
 * Effective sandbox policy digest: binds a container to the image it runs and
 * the scope's resolved policy at provision time. `descriptor.policyDigest`
 * already hashes envAllowlist/toolPolicy/limits (scoped-runtime.ts); the
 * derived network mode is included explicitly so any future change to the
 * limits→network mapping also invalidates reuse.
 */
function sandboxPolicyDigestOf(descriptor: ScopedRuntimeDescriptor, image: string): string {
  return `sha256:${createHash("sha256").update(`${image}\n${networkModeFor(descriptor)}\n${descriptor.policyDigest}`).digest("hex")}`;
}

/**
 * Refuses reuse of a container whose recorded policy does not match the
 * caller's current descriptor — the same owner tightening (or otherwise
 * changing) policy must not inherit a container provisioned under the old,
 * possibly broader, policy. Legacy registries without a recorded digest
 * cannot be validated and fail closed. Never deletes anything: the container
 * and workspace are preserved for deliberate operator remediation.
 */
function assertRegisteredPolicy(descriptor: ScopedRuntimeDescriptor, entry: SandboxRegistryEntry): void {
  const path = registryPath(descriptor);
  const remedy = `Workspace and container are preserved; after verifying nothing in the workspace is needed by the old policy, stop and remove container ${entry.containerName} and delete ${path}, then re-provision under the current policy.`;
  if (!entry.policyDigest) {
    throw new SandboxPolicyError(
      `Registry at ${path} predates policy binding and cannot be validated against this scope's current policy; refusing to reuse container ${entry.containerName}. ${remedy}`,
    );
  }
  const expected = sandboxPolicyDigestOf(descriptor, entry.image);
  if (entry.policyDigest !== expected) {
    throw new SandboxPolicyError(
      `Sandbox ${entry.containerName} was provisioned under a different policy (recorded ${entry.policyDigest}, current ${expected}); refusing to reuse it under this scope's current policy. ${remedy}`,
    );
  }
}

function registryPath(descriptor: ScopedRuntimeDescriptor): string {
  return join(controlDir(descriptor), REGISTRY_FILE);
}

async function loadRegistry(descriptor: ScopedRuntimeDescriptor): Promise<SandboxRegistryEntry | null> {
  try {
    const raw = await readFile(registryPath(descriptor), "utf8");
    return JSON.parse(raw) as SandboxRegistryEntry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveRegistry(descriptor: ScopedRuntimeDescriptor, entry: SandboxRegistryEntry): Promise<void> {
  await mkdir(controlDir(descriptor), { recursive: true, mode: 0o700 });
  const path = registryPath(descriptor);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Raw docker CLI invocation: collects bounded stdout/stderr, resolves exit code, never throws on nonzero exit. */
function dockerExec(
  dockerBin: string,
  args: readonly string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; maxBufferBytes?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; stdoutTruncated: boolean; stderrTruncated: boolean }> {
  const maxBufferBytes = opts.maxBufferBytes ?? 1024 * 1024;
  type DockerExecResult = {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  // Not Promise.withResolvers: tsconfig lib predates es2024.
  let resolve!: (value: DockerExecResult) => void;
  const promise = new Promise<DockerExecResult>((r) => {
    resolve = r;
  });

  const child = spawn(dockerBin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let settled = false;
  let timedOut = false;
  let cancelled = false;
  let killTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;

  const gradedKill = () => {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  };

  const onAbort = () => {
    cancelled = true;
    gradedKill();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  if (opts.timeoutMs !== undefined) {
    hardTimer = setTimeout(() => {
      timedOut = true;
      gradedKill();
    }, opts.timeoutMs);
    hardTimer.unref?.();
  }

  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.length >= maxBufferBytes) {
      stdoutTruncated = true;
      return;
    }
    stdout += chunk.toString("utf8");
    if (stdout.length > maxBufferBytes) {
      stdout = stdout.slice(0, maxBufferBytes);
      stdoutTruncated = true;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length >= maxBufferBytes) {
      stderrTruncated = true;
      return;
    }
    stderr += chunk.toString("utf8");
    if (stderr.length > maxBufferBytes) {
      stderr = stderr.slice(0, maxBufferBytes);
      stderrTruncated = true;
    }
  });

  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    if (killTimer) clearTimeout(killTimer);
    if (hardTimer) clearTimeout(hardTimer);
    opts.signal?.removeEventListener("abort", onAbort);
    child.unref();
    resolve({ code, stdout, stderr, timedOut, cancelled, stdoutTruncated, stderrTruncated });
  };
  child.on("error", () => finish(-1));
  child.on("close", (code) => finish(code ?? -1));

  return promise;
}

/**
 * Local Docker-backed `Sandbox` provider: one durable container per owning
 * scope, reattached by deterministic name across process restarts.
 */
export class LocalDockerSandbox {
  private readonly dockerBin: string;
  private readonly defaultImage: string;

  constructor(options: LocalDockerSandboxOptions = {}) {
    this.dockerBin = options.dockerBin ?? "docker";
    this.defaultImage = options.image ?? DEFAULT_SANDBOX_IMAGE;
  }

  /**
   * Idempotent: reattaches to an existing container for this scope if the
   * registry + `docker inspect` agree it is still present, restarting it if
   * stopped; otherwise creates one. Never creates a second container for the
   * same scope.
   */
  async provision(descriptor: ScopedRuntimeDescriptor, options: { image?: string } = {}): Promise<SandboxHandle> {
    const ownerDigest = ownerDigestOf(descriptor);
    const containerName = containerNameFor(descriptor);
    const image = options.image ?? this.defaultImage;

    const existing = await loadRegistry(descriptor);
    if (existing) {
      if (existing.ownerDigest !== ownerDigest) {
        throw new SandboxOwnershipError(
          `Registry at ${registryPath(descriptor)} is owned by a different scope policy; refusing to reuse or overwrite.`,
        );
      }
      assertRegisteredPolicy(descriptor, existing);
      const state = await this.inspectContainer(existing.containerName);
      if (state !== "absent") {
        await this.assertLiveOwnership(existing.containerName, ownerDigest);
        if (state === "stopped") {
          await this.startContainer(existing.containerName);
        }
        return { id: existing.containerName, ownerDigest: existing.ownerDigest, image: existing.image, createdAt: existing.createdAt };
      }
      // Registry pointed at a container docker no longer has (e.g. pruned) — recreate under the same name.
    }
    // No registry entry, yet a container may squat on this scope's name
    // (created outside the provider). Adopting it would grant the squatter
    // this scope's workspace mount; refuse instead of surfacing an opaque
    // `docker run` name conflict.
    if ((await this.inspectContainer(containerName)) !== "absent") {
      throw new SandboxOwnershipError(
        `Container ${containerName} exists but is not registered to this scope; refusing to adopt it.`,
      );
    }

    await mkdir(mountDir(descriptor), { recursive: true, mode: 0o700 });
    await mkdir(controlDir(descriptor), { recursive: true, mode: 0o700 });
    // Layers are validated (and must exist) before any `docker run`; a missing layer never yields a container without it.
    const layerArgs = await sandboxLayerMountArgs(descriptor);
    const run = await dockerExec(this.dockerBin, [
      "run",
      "-d",
      // PID 1 is otherwise `sleep infinity`, which never reaps: every orphaned process (a killed command's children,
      // anything backgrounded) stays a zombie and eats the pids limit until forks fail. docker-init reaps them.
      "--init",
      "--name",
      containerName,
      "--label",
      "muster.sandbox=1",
      "--label",
      `muster.owner=${ownerDigest.replace(/[^a-zA-Z0-9:._-]/g, "")}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...sandboxResourceArgs(descriptor),
      "--network",
      networkModeFor(descriptor),
      "--mount",
      `type=bind,source=${mountDir(descriptor)},target=/workspace`,
      ...layerArgs,
      "-w",
      "/workspace",
      image,
      "sleep",
      "infinity",
    ]);
    if (run.code !== 0) {
      throw new SandboxProviderError(`docker run failed for sandbox ${containerName}: exit ${run.code}`, run.stderr);
    }

    const createdAt = new Date().toISOString();
    const entry: SandboxRegistryEntry = { containerName, ownerDigest, image, createdAt, policyDigest: sandboxPolicyDigestOf(descriptor, image) };
    await saveRegistry(descriptor, entry);
    return { id: containerName, ownerDigest, image, createdAt };
  }

  /** Reattach without creating — returns null if no sandbox has ever been provisioned for this scope. */
  async reattach(descriptor: ScopedRuntimeDescriptor): Promise<SandboxHandle | null> {
    const existing = await loadRegistry(descriptor);
    if (!existing) return null;
    if (existing.ownerDigest !== ownerDigestOf(descriptor)) {
      throw new SandboxOwnershipError(`Registry at ${registryPath(descriptor)} does not match this scope's policy digest.`);
    }
    assertRegisteredPolicy(descriptor, existing);
    const state = await this.inspectContainer(existing.containerName);
    if (state === "absent") return null;
    await this.assertLiveOwnership(existing.containerName, existing.ownerDigest);
    if (state === "stopped") await this.startContainer(existing.containerName);
    return { id: existing.containerName, ownerDigest: existing.ownerDigest, image: existing.image, createdAt: existing.createdAt };
  }
  /**
   * Verifies the live container's `muster.owner` label against the scope's
   * digest before the provider starts or reuses it. A container squatting on
   * this scope's name (created outside the provider, or relabeled) must not
   * be adopted. Fail-closed: an inspect failure that is not a genuine
   * "no such container" refuses the operation rather than silently passing —
   * a daemon error must never be read as "ownership OK". A truly absent
   * container passes; callers handle that state.
   */
  private async assertLiveOwnership(containerName: string, expectedDigest: string): Promise<void> {
    const label = await dockerExec(this.dockerBin, ["inspect", "-f", `{{index .Config.Labels "muster.owner"}}`, containerName]);
    if (label.code !== 0) {
      if (/no such (container|object)/i.test(label.stderr)) return;
      throw new SandboxProviderError(
        `docker inspect failed for ${containerName}: exit ${label.code}; cannot verify ownership`,
        label.stderr,
      );
    }
    if (label.stdout.trim() !== expectedDigest) {
      throw new SandboxOwnershipError(`Container ${containerName} is not owned by this scope; refusing to operate on it.`);
    }
  }

  /**
   * Authoritative identity check. Trusts NOTHING on the caller-supplied
   * handle: the container name is recomputed from the caller's own
   * descriptor, cross-checked against the scope's registry (control dir,
   * never mounted into any container), and finally against the live
   * container's `muster.owner` label. A forged handle carrying another
   * scope's container id — or any non-Muster container — is rejected before
   * the backend is invoked with that id.
   */
  private async assertOwnership(handle: SandboxHandle, descriptor: ScopedRuntimeDescriptor): Promise<void> {
    const callerDigest = ownerDigestOf(descriptor);
    const expectedName = containerNameFor(descriptor);
    if (handle.id !== expectedName) {
      throw new SandboxOwnershipError(`Handle id ${handle.id} does not name this scope's sandbox; refusing to operate on it.`);
    }
    if (handle.ownerDigest !== callerDigest) {
      throw new SandboxOwnershipError(`Scope with policy digest ${callerDigest} may not act on sandbox ${handle.id} owned by ${handle.ownerDigest}.`);
    }
    const registered = await loadRegistry(descriptor);
    if (!registered || registered.containerName !== expectedName || registered.ownerDigest !== callerDigest) {
      throw new SandboxOwnershipError(`No registered sandbox for this scope matches handle ${handle.id}; refusing to operate on it.`);
    }
    assertRegisteredPolicy(descriptor, registered);
    // Squatting container check — see assertLiveOwnership.
    await this.assertLiveOwnership(expectedName, callerDigest);
  }

  /**
   * Enforces the scope's resolved env allowlist at the exec boundary —
   * `envAllowlist` is a declaration until an executor applies it, and this is
   * the executor. Rejects by KEY only; values never appear in errors or logs.
   */
  private assertEnvAllowed(descriptor: ScopedRuntimeDescriptor, env: Readonly<Record<string, string>>): void {
    const denied = Object.keys(env).filter((key) => !descriptor.envAllowlist.includes(key));
    if (denied.length > 0) {
      throw new SandboxOwnershipError(`Env var(s) not in this scope's allowlist: ${denied.sort().join(", ")}.`);
    }
  }

  /**
   * Run a command inside the sandbox. Cancellation (via `signal` or
   * `timeoutMs`) kills the actual in-container process by PID — not just the
   * host-side `docker exec` client — so a cancelled run cannot keep consuming
   * CPU inside the container after this call returns.
   */
  async run(handle: SandboxHandle, descriptor: ScopedRuntimeDescriptor, command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    await this.assertOwnership(handle, descriptor);
    const env = options.env ?? {};
    this.assertEnvAllowed(descriptor, env);
    const pidMarker = `__MUSTER_SBX_PID__`;
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(env)) {
      envArgs.push("-e", `${key}=${value}`);
    }
    // `echo` the shell's own PID (unchanged across `exec`, which replaces the
    // process image in place) as a parseable first stderr line, then hand off
    // to the real command so `kill <pid>` targets exactly this run.
    const wrapped = `echo ${pidMarker}:$$ 1>&2; exec sh -c ${shellQuote(command)}`;
    const args = ["exec", ...envArgs, handle.id, "sh", "-c", wrapped];

    const result = await dockerExec(this.dockerBin, args, {
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes,
      signal: options.signal,
    });

    let stderr = result.stderr;
    const marker = stderr.indexOf(`${pidMarker}:`);
    if (marker !== -1) {
      const newline = stderr.indexOf("\n", marker);
      const line = newline === -1 ? stderr.slice(marker) : stderr.slice(marker, newline);
      const pid = line.slice(pidMarker.length + 1).trim();
      stderr = newline === -1 ? "" : stderr.slice(newline + 1);
      if ((options.signal?.aborted || result.timedOut) && pid) {
        // Best-effort: kill the actual in-container process group by PID. The
        // host-side client is already dead (dockerExec's gradedKill); this
        // stops the process INSIDE the container from continuing to run.
        // Negative PID targets the whole group (wrapper's `exec` keeps the
        // shell's pgid); dash's kill rejects `--`, so pass -$pid directly.
        await dockerExec(this.dockerBin, ["exec", handle.id, "sh", "-c", `kill -TERM -${pid} 2>/dev/null; sleep 0.2; kill -KILL -${pid} 2>/dev/null; true`]).catch(() => {});
      }
    }

    return {
      stdout: result.stdout,
      stderr,
      exitCode: result.code,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    };
  }

  async inspect(handle: SandboxHandle, descriptor: ScopedRuntimeDescriptor): Promise<SandboxInspectResult> {
    await this.assertOwnership(handle, descriptor);
    const state = await dockerExec(this.dockerBin, ["inspect", "-f", "{{.State.Running}}|{{.State.ExitCode}}", handle.id]);
    if (state.code !== 0) {
      if (/no such (container|object)/i.test(state.stderr)) return {running: false, exitCode: null};
      throw new SandboxProviderError(`docker inspect failed for ${handle.id}: exit ${state.code}`, state.stderr);
    }
    const [running, exitCode] = state.stdout.trim().split("|");
    if (!['true','false'].includes(running) || !/^-?\d+$/.test(exitCode ?? '')) throw new SandboxProviderError('Invalid sandbox state response', '');
    return { running: running === "true", exitCode: running === "true" ? null : Number(exitCode) };
  }

  /** Ordinary shutdown: halts the container but retains it, the registry entry, and the durable workspace. `provision`/`reattach` restart it. */
  async stop(handle: SandboxHandle, descriptor: ScopedRuntimeDescriptor): Promise<void> {
    await this.assertOwnership(handle, descriptor);
    const result = await dockerExec(this.dockerBin, ["stop", handle.id]);
    if (result.code !== 0 && !/no such (container|object)/i.test(result.stderr)) {
      throw new SandboxProviderError(`docker stop failed for sandbox ${handle.id}: exit ${result.code}`, result.stderr);
    }
  }

  /**
   * Explicit disposal, distinct from stop: removes the environment-owned
   * resources only — the container and this scope's registry entry. The
   * durable workspace directory is retained data and is NOT deleted here;
   * exporting/removing it is a separate, reviewed action.
   */
  async destroy(handle: SandboxHandle, descriptor: ScopedRuntimeDescriptor): Promise<void> {
    await this.assertOwnership(handle, descriptor);
    const result = await dockerExec(this.dockerBin, ["rm", "-f", handle.id]);
    if (result.code !== 0 && !/no such (container|object)/i.test(result.stderr)) {
      throw new SandboxProviderError(`docker rm failed for sandbox ${handle.id}: exit ${result.code}`, result.stderr);
    }
    await rm(registryPath(descriptor), { force: true });
  }

  /**
   * Fail-closed container state probe. Only a genuine "no such container"
   * from the docker CLI maps to "absent"; any other nonzero exit (daemon
   * down, permission denied, CLI missing) raises SandboxProviderError so a
   * transient failure can never be mistaken for a free name and trigger
   * adoption/creation over an unknown container.
   */
  private async inspectContainer(containerName: string): Promise<"running" | "stopped" | "absent"> {
    const state = await dockerExec(this.dockerBin, ["inspect", "-f", "{{.State.Running}}", containerName]);
    if (state.code !== 0) {
      if (/no such (container|object)/i.test(state.stderr)) return "absent";
      throw new SandboxProviderError(
        `docker inspect failed for ${containerName}: exit ${state.code}; cannot determine container state`,
        state.stderr,
      );
    }
    const value = state.stdout.trim();
    if (value !== 'true' && value !== 'false') throw new SandboxProviderError(`Invalid container state for ${containerName}`, '');
    return value === "true" ? "running" : "stopped";
  }

  private async startContainer(containerName: string): Promise<void> {
    const result = await dockerExec(this.dockerBin, ['start', containerName]);
    if (result.code !== 0) throw new SandboxProviderError(`docker start failed for ${containerName}: exit ${result.code}`, result.stderr);
  }
}

function shellQuote(command: string): string {
  return `'${command.replace(/'/g, `'\\''`)}'`;
}

/** No separate cancellation path today beyond the caller's own signal; kept as a seam for a future watchdog without changing `run`'s signature. */
function cancellationFromPid(
  _sandbox: LocalDockerSandbox,
  _handle: SandboxHandle,
  _pidMarker: string,
  options: SandboxExecOptions,
): AbortSignal | undefined {
  return options.signal;
}
