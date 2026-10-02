/**
 * The `agentcompanies/v1` package format (Wave 4: G16, G17): markdown files with YAML front matter that describe a company or team, its
 * agents, projects, tasks and skills. Format: Paperclip's companies-spec.md (MIT, Copyright (c) 2025 Paperclip AI). This file reads and
 * writes the subset Muster uses: a small YAML reader, a store-and-inflate zip reader and writer, and a package model.
 * Nothing here touches the disk or the network; callers hand it files and get files back.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// ── YAML subset ───────────────────────────────────────────────────────────────
export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };
const scalar = (raw: string): Yaml => {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true; if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) { try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('[') && t.endsWith(']')) { const inner = t.slice(1, -1).trim(); return inner ? splitTop(inner).map(scalar) : []; }
  return t;
};
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, quote = '', cur = '';
  for (const c of s) {
    if (quote) { cur += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++; if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
export function parseYaml(text: string): Yaml {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+#.*$/, (m, off, whole) => /["']/.test(whole.slice(0, off)) ? m : '')).filter(l => l.trim() && !l.trim().startsWith('#'));
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  function block(indent: number): Yaml {
    if (i >= lines.length) return null;
    if (lines[i]!.trim().startsWith('- ') || lines[i]!.trim() === '-') {
      const list: Yaml[] = [];
      while (i < lines.length && indentOf(lines[i]!) === indent && (lines[i]!.trim().startsWith('- ') || lines[i]!.trim() === '-')) {
        const rest = lines[i]!.trim().slice(1).trim();
        if (!rest) { i++; list.push(i < lines.length && indentOf(lines[i]!) > indent ? block(indentOf(lines[i]!)) : null); continue; }
        if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(rest) && !rest.startsWith('"')) { lines[i] = ' '.repeat(indent + 2) + rest; list.push(block(indent + 2)); continue; }
        i++; list.push(scalar(rest));
      }
      return list;
    }
    const map: { [k: string]: Yaml } = {};
    while (i < lines.length && indentOf(lines[i]!) === indent && !lines[i]!.trim().startsWith('- ')) {
      const m = /^([^:]+?):(?:\s+(.*))?$/.exec(lines[i]!.trim());
      if (!m) throw new Error(`Cannot read this line of the package: ${lines[i]!.trim().slice(0, 80)}`);
      const key = m[1]!.trim().replace(/^["']|["']$/g, ''), rest = m[2];
      i++;
      let value: Yaml;
      if (rest !== undefined && rest.trim() !== '') value = scalar(rest);
      else if (i < lines.length && (indentOf(lines[i]!) > indent || (indentOf(lines[i]!) === indent && lines[i]!.trim().startsWith('- ')))) value = block(indentOf(lines[i]!));
      else value = null;
      // A package is untrusted: these keys would rewrite the prototype of every object after them. The value is read and dropped.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return map;
  }
  return lines.length ? block(indentOf(lines[0]!)) : {};
}
const needsQuote = (s: string) => s === '' || /^[\s>|*&!%@`#\-?:,[\]{}'"]|:\s|\s#|\s$|^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) || s.includes('\n');
export function dumpYaml(v: Yaml, indent = 0): string {
  const pad = ' '.repeat(indent), one = (x: Yaml): string => typeof x === 'string' ? (needsQuote(x) ? JSON.stringify(x) : x) : x === null ? 'null' : String(x);
  if (Array.isArray(v)) return v.map(x => x && typeof x === 'object' ? `${pad}-\n${dumpYaml(x, indent + 2)}` : `${pad}- ${one(x)}`).join('\n');
  if (v && typeof v === 'object') return Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => {
    if (x && typeof x === 'object') { const inner = Array.isArray(x) ? (x.length ? dumpYaml(x, indent + 2) : '') : (Object.keys(x).length ? dumpYaml(x, indent + 2) : ''); return inner ? `${pad}${k}:\n${inner}` : `${pad}${k}: ${Array.isArray(x) ? '[]' : '{}'}`; }
    return `${pad}${k}: ${one(x)}`;
  }).join('\n');
  return `${pad}${one(v)}`;
}
export function parseDoc(text: string): { data: { [k: string]: Yaml }; body: string } {
  const t = text.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) return { data: {}, body: t.trim() };
  const data = parseYaml(m[1]!);
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}, body: m[2]!.trim() };
}
export const dumpDoc = (data: { [k: string]: Yaml }, body: string) => `---\n${dumpYaml(data)}\n---\n\n${body.trim()}\n`;
export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';

// ── zip (store and deflate on write, store and deflate on read) ───────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export const ZIP_LIMITS = { files: 2000, fileBytes: 2_000_000, totalBytes: 20_000_000 } as const;
export function zipFiles(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8'), packed = deflateRawSync(raw), method = packed.length < raw.length ? 8 : 0, data = method === 8 ? packed : raw, nm = Buffer.from(name, 'utf8'), crc = crc32(raw);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(0x21, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nm.length, 26);
    parts.push(local, nm, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(0x21, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nm); offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
/** Reads a zip, refusing path tricks and zip bombs. The limits count the bytes ACTUALLY inflated, not the sizes an entry declares; an entry whose
 *  real size differs from its declared one, or that shares compressed data with another, is refused. */
export function unzipFiles(zip: Buffer): Record<string, string> {
  let end = -1; for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('This is not a zip file.');
  const count = zip.readUInt16LE(end + 10); let p = zip.readUInt32LE(end + 16);
  if (count > ZIP_LIMITS.files) throw new Error(`The package has more than ${ZIP_LIMITS.files} files.`);
  const out: Record<string, string> = {}, ranges: [number, number][] = []; let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip is damaged.');
    const method = zip.readUInt16LE(p + 10), csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24), nlen = zip.readUInt16LE(p + 28), xlen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32), lh = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('utf8'); p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const norm = name.replace(/\\/g, '/');
    if (norm.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(norm) || norm.includes('\0')) throw new Error(`The package has an unsafe path: ${name.slice(0, 80)}`);
    if (!/\.(md|ya?ml|json|txt)$/i.test(norm)) continue;
    if (usize > ZIP_LIMITS.fileBytes) throw new Error('The package is too large to import.');
    if (lh + 30 > zip.length || zip.readUInt32LE(lh) !== 0x04034b50) throw new Error('The zip is damaged.');
    const start = lh + 30 + zip.readUInt16LE(lh + 26) + zip.readUInt16LE(lh + 28);
    if (start + csize > zip.length) throw new Error('The zip is damaged.');
    // Two entries must never read the same compressed bytes: that is how a tiny zip inflates to gigabytes.
    for (const [a, b] of ranges) if (start < b && start + Math.max(csize, 1) > a) throw new Error(`${name.slice(0, 80)} shares data with another entry; the package is refused.`);
    ranges.push([start, start + Math.max(csize, 1)]);
    const data = zip.subarray(start, start + csize);
    if (method === 0 && csize !== usize) throw new Error(`${name.slice(0, 80)} is not the size it declares; the package is refused.`);
    let raw: Buffer;
    if (method === 0) raw = data;
    else if (method === 8) {
      try { raw = inflateRawSync(data, { maxOutputLength: Math.min(usize, ZIP_LIMITS.totalBytes - total) + 1 }); }
      catch { throw new Error('The package is too large to import, or damaged.'); }
    } else throw new Error(`${name} uses an unsupported compression.`);
    if (raw.length !== usize) throw new Error(`${name.slice(0, 80)} is not the size it declares; the package is refused.`);
    total += raw.length;
    if (total > ZIP_LIMITS.totalBytes) throw new Error('The package is too large to import.');
    out[norm] = raw.toString('utf8');
  }
  return out;
}

// ── package model ─────────────────────────────────────────────────────────────
export interface PkgAgent { slug: string; name: string; title: string | null; reportsTo: string | null; skills: string[]; instructions: string; files: Record<string, string>; ext: { [k: string]: Yaml } }
export interface PkgTask { slug: string; name: string; assignee: string | null; project: string | null; recurring: boolean; priority: number | null; body: string; ext: { [k: string]: Yaml } }
export interface PkgProject { slug: string; name: string; description: string; owner: string | null }
export interface PkgModel {
  kind: 'company' | 'team'; slug: string; name: string; description: string; manager: string | null; schema: string;
  agents: PkgAgent[]; projects: PkgProject[]; tasks: PkgTask[]; skills: { slug: string; name: string }[]; requirements: { secrets: string[] };
  /** Things in the package Muster does not import, said once each. */
  ignored: string[];
}
const str = (v: Yaml | undefined): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
const strList = (v: Yaml | undefined): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const slugOfPath = (p: string, marker: string) => p.split('/')[p.split('/').indexOf(marker) + 1] ?? '';

export function readPackage(files: Record<string, string>): PkgModel {
  const paths = Object.keys(files);
  // The package root is the shallowest folder holding COMPANY.md or TEAM.md (a zip made from a folder wraps it in one more).
  const roots = paths.filter(p => /(^|\/)(COMPANY|TEAM)\.md$/.test(p)).sort((a, b) => a.split('/').length - b.split('/').length);
  if (!roots.length) throw new Error('This is not an Agent Companies package: it has no COMPANY.md or TEAM.md.');
  const rootFile = roots[0]!, prefix = rootFile.slice(0, rootFile.length - (rootFile.endsWith('COMPANY.md') ? 10 : 7));
  const rel = (p: string) => p.slice(prefix.length), inside = paths.filter(p => p.startsWith(prefix));
  const root = parseDoc(files[rootFile]!);
  const schema = str(root.data.schema) ?? 'agentcompanies/v1';
  if (!/^agentcompanies\/v1/.test(schema)) throw new Error(`This package uses ${schema}; Muster reads agentcompanies/v1.`);
  const ext = (() => { const f = inside.find(p => /(^|\/)\.(muster|paperclip)\.ya?ml$/.test(rel(p)) && rel(p).split('/').length === 1); if (!f) return {} as { [k: string]: Yaml }; try { const y = parseYaml(files[f]!); return y && typeof y === 'object' && !Array.isArray(y) ? y : {}; } catch { return {}; } })();
  const agents: PkgAgent[] = [], tasks: PkgTask[] = [], projects: PkgProject[] = [], skills: { slug: string; name: string }[] = [], ignored: string[] = [];
  const agentExt = (ext.agents && typeof ext.agents === 'object' && !Array.isArray(ext.agents) ? ext.agents : {}) as { [k: string]: Yaml };
  for (const p of inside.filter(p => /(^|\/)agents\/[^/]+\/AGENTS\.md$/.test(rel(p)))) {
    const slug = slugOfPath(rel(p), 'agents'), d = parseDoc(files[p]!), dir = p.slice(0, p.length - 'AGENTS.md'.length);
    const bundle: Record<string, string> = {}; for (const q of inside) if (q.startsWith(dir) && q !== p && /\.md$/i.test(q) && !q.slice(dir.length).includes('/')) bundle[q.slice(dir.length)] = files[q]!;
    const e = agentExt[slug]; agents.push({ slug, name: str(d.data.name) ?? slug, title: str(d.data.title), reportsTo: str(d.data.reportsTo), skills: strList(d.data.skills), instructions: d.body, files: bundle, ext: e && typeof e === 'object' && !Array.isArray(e) ? e : {} });
  }
  for (const p of inside.filter(p => /(^|\/)TASK\.md$/.test(rel(p)))) {
    const d = parseDoc(files[p]!), parts = rel(p).split('/'), slug = str(d.data.slug) ?? parts[parts.length - 2] ?? 'task';
    const te = ext.routines && typeof ext.routines === 'object' && !Array.isArray(ext.routines) ? (ext.routines as { [k: string]: Yaml })[slug] : undefined;
    tasks.push({ slug, name: str(d.data.name) ?? slug, assignee: str(d.data.assignee), project: str(d.data.project), recurring: d.data.recurring === true, priority: typeof d.data.priority === 'number' ? d.data.priority : null, body: d.body, ext: te && typeof te === 'object' && !Array.isArray(te) ? te : {} });
  }
  for (const p of inside.filter(p => /(^|\/)PROJECT\.md$/.test(rel(p)))) { const d = parseDoc(files[p]!), parts = rel(p).split('/'); projects.push({ slug: str(d.data.slug) ?? parts[parts.length - 2] ?? 'project', name: str(d.data.name) ?? 'Project', description: d.body, owner: str(d.data.owner) }); }
  for (const p of inside.filter(p => /(^|\/)skills\/[^/]+\/SKILL\.md$/.test(rel(p)))) skills.push({ slug: slugOfPath(rel(p), 'skills'), name: str(parseDoc(files[p]!).data.name) ?? slugOfPath(rel(p), 'skills') });
  if (skills.length) ignored.push(`${skills.length} skill${skills.length === 1 ? '' : 's'} (${skills.slice(0, 4).map(s => s.slug).join(', ')}${skills.length > 4 ? ', …' : ''}): install them from the Skills page.`);
  const includes = strList(root.data.includes).filter(x => /^https?:\/\//.test(x));
  if (includes.length) ignored.push(`${includes.length} included package${includes.length === 1 ? '' : 's'} on the web (not fetched).`);
  const reqs = root.data.requirements && typeof root.data.requirements === 'object' && !Array.isArray(root.data.requirements) ? (root.data.requirements as { [k: string]: Yaml }).secrets : [];
  const mgr = str(root.data.manager);
  return { kind: rootFile.endsWith('COMPANY.md') ? 'company' : 'team', slug: str(root.data.slug) ?? slugify(str(root.data.name) ?? 'package'), name: str(root.data.name) ?? 'Package', description: root.body || str(root.data.description) || '',
    manager: mgr ? (/agents\/([^/]+)\//.exec(mgr)?.[1] ?? slugify(mgr)) : null, schema, agents, projects, tasks, skills, requirements: { secrets: strList(reqs) }, ignored };
}
