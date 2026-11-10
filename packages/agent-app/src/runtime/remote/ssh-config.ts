/** #147: the plain `Host` aliases of ~/.ssh/config, for Settings to offer. Read only; ssh itself applies the whole file when it connects. */
import { readFileSync } from 'node:fs';

export interface ConfigHost { alias: string; hostName?: string; user?: string; port?: number }
/** An alias Muster passes to ssh: never an option (`-…`), never a pattern. */
export const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function parseSshConfig(text: string): ConfigHost[] {
  const hosts: ConfigHost[] = []; let block: ConfigHost[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim(); if (!line) continue;
    const match = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line); if (!match) continue;
    const key = match[1]!.toLowerCase(), value = match[2]!.trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      block = value.split(/\s+/).filter(a => ALIAS.test(a) && !hosts.some(h => h.alias === a)).map(alias => ({ alias }));
      hosts.push(...block); continue;
    }
    if (key === 'match') { block = []; continue; }
    for (const h of block) {
      if (key === 'hostname' && h.hostName === undefined) h.hostName = value;
      else if (key === 'user' && h.user === undefined) h.user = value;
      else if (key === 'port' && h.port === undefined && /^\d{1,5}$/.test(value)) h.port = Number(value);
    }
  }
  return hosts;
}
export function readSshConfig(file: string): ConfigHost[] {
  try { return parseSshConfig(readFileSync(file, 'utf8')); } catch { return []; }
}
