/** Data directory layout and the non-secret server.json. Secrets never go in server.json. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_PORT = 7470;
export const DEFAULT_HOST = '127.0.0.1';
export interface ServerConfig {
  version: 1;
  host: string; port: number;
  /** Hostnames the server answers to besides loopback (DNS-rebinding and Host-header protection). Required to bind beyond loopback. */
  allowedHosts: string[];
  tlsCert: string | null; tlsKey: string | null;
  /** The URL people use (for invite links) when it differs from host:port, e.g. behind Caddy or nginx. */
  publicUrl: string | null;
  /** Trust X-Forwarded-Proto/For from a reverse proxy on loopback. */
  trustProxy: boolean;
  /** What people call this server's organisation (set at init, editable by the owner). Apps show it instead of the address. */
  orgName: string | null;
  createdAt: string;
}
export const cleanOrgName = (value: unknown): string | null => { if (typeof value !== 'string') return null; const t = value.replace(/\s+/g, ' ').trim().slice(0, 80); return t || null; };
export const defaultConfig = (): ServerConfig => ({ version: 1, host: DEFAULT_HOST, port: DEFAULT_PORT, allowedHosts: [], tlsCert: null, tlsKey: null, publicUrl: null, trustProxy: false, orgName: null, createdAt: new Date().toISOString() });

export interface Paths { dir: string; config: string; db: string; key: string; runtime: string; pid: string; log: string }
export function resolveDataDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = flag || env.MUSTER_SERVER_DATA_DIR || join(homedir(), '.muster-server');
  return isAbsolute(raw) ? raw : resolve(raw);
}
export function paths(dir: string): Paths {
  return { dir, config: join(dir, 'server.json'), db: join(dir, 'server.sqlite'), key: join(dir, 'keys', 'secret.key'), runtime: join(dir, 'runtime'),
    pid: join(dir, 'server.pid'), log: join(dir, 'logs', 'server.log') };
}
export function readConfig(p: Paths): ServerConfig | null {
  if (!existsSync(p.config)) return null;
  const raw = JSON.parse(readFileSync(p.config, 'utf8')) as Partial<ServerConfig>;
  return { ...defaultConfig(), ...raw, orgName: cleanOrgName(raw.orgName), allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts.map(String) : [] };
}
export function writeConfig(p: Paths, config: ServerConfig): void {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const tmp = `${p.config}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p.config);
  try { chmodSync(p.config, 0o600); } catch { /* no modes */ }
}

export const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) || /^127\./.test(host);

/** Rules for binding. Returns warnings; throws on unsafe configurations. */
export function validateBind(config: Pick<ServerConfig, 'host' | 'port' | 'allowedHosts' | 'tlsCert' | 'tlsKey' | 'trustProxy'>): string[] {
  const warnings: string[] = [];
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error(`Invalid port ${config.port}.`);
  if (Boolean(config.tlsCert) !== Boolean(config.tlsKey)) throw new Error('Pass both --tls-cert and --tls-key, or neither.');
  for (const file of [config.tlsCert, config.tlsKey]) if (file && !existsSync(file)) throw new Error(`TLS file not found: ${file}`);
  for (const host of config.allowedHosts) if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host) && !/^\[[0-9a-f:]+\]$/i.test(host)) throw new Error(`Invalid --allowed-host "${host}". Use a hostname such as muster.example.com.`);
  if (!isLoopback(config.host)) {
    if (!config.allowedHosts.length) throw new Error(`Binding to ${config.host} exposes the server beyond this machine. Add --allowed-host <hostname> for every name people use to reach it.`);
    if (!config.tlsCert) warnings.push(`Serving on ${config.host} without TLS: passwords and session cookies cross the network in clear text. Pass --tls-cert/--tls-key, or keep the default 127.0.0.1 bind behind a TLS reverse proxy (Caddy or nginx; see docs/server.md).`);
  }
  return warnings;
}

/** Host header check: loopback names always; otherwise only the allow-list. Blocks DNS rebinding against a loopback bind. */
export function hostAllowed(hostHeader: string | undefined, config: Pick<ServerConfig, 'allowedHosts'>): boolean {
  if (!hostHeader) return false;
  const name = hostHeader.toLowerCase().replace(/:\d+$/, '');
  if (isLoopback(name)) return true;
  return config.allowedHosts.some(h => h.toLowerCase().replace(/:\d+$/, '') === name);
}
