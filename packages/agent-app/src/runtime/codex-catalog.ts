/**
 * Reads a Codex model catalog (`model_catalog_json`) in Codex's own schema:
 *   {"models": [{"slug": "...", "display_name": "...", "supported_reasoning_levels": [...], ...}], ...}
 * Each failure says exactly what is wrong (which file, which field, why) instead of one catch-all
 * "missing or unreadable" line. A symlinked catalog is followed, as Codex follows it.
 */
import * as nodeFs from 'node:fs';

export type CatalogFs = Pick<typeof nodeFs, 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'>;
/** Codex catalogs carry each model's full base instructions, so a real catalog can be several MB. */
export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
export type CatalogRead = {ok: true; models: unknown[]; incremental: boolean} | {ok: false; error: string};

const kind = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value === 'object' ? 'an object' : `a ${typeof value}`;
/** "line 3, column 7" from a JSON.parse error's position; never echoes the file's text. */
function jsonWhere(text: string, error: unknown): string {
  const position = /position (\d+)/.exec(error instanceof Error ? error.message : '')?.[1];
  if (position === undefined) return /Unexpected end/i.test(error instanceof Error ? error.message : '') ? 'the file ends early (truncated?)' : 'invalid JSON';
  const before = text.slice(0, Number(position)).split('\n');
  return `line ${before.length}, column ${before.at(-1)!.length + 1}`;
}

export function readCodexCatalog(path: string, fs: CatalogFs = nodeFs): CatalogRead {
  const fail = (why: string): CatalogRead => ({ok: false, error: `The model catalog ${path} ${why}`});
  let fd: number;
  try { fd = fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(code === 'ENOENT' ? 'does not exist. Fix model_catalog_json in the Codex profile.'
      : code === 'EACCES' || code === 'EPERM' ? `cannot be read by Muster (${code}: permission denied).`
      : code === 'ELOOP' ? 'is a symlink loop.'
      : `cannot be opened (${code ?? 'unknown error'}).`);
  }
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return fail('is not a regular file.');
    if (stat.size > MAX_CATALOG_BYTES) return fail(`is ${(stat.size / 1048576).toFixed(1)} MB; Muster reads catalogs up to ${MAX_CATALOG_BYTES / 1048576} MB.`);
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_CATALOG_BYTES) + 1); let length = 0;
    while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length > MAX_CATALOG_BYTES) return fail(`is larger than ${MAX_CATALOG_BYTES / 1048576} MB.`);
    text = bytes.subarray(0, length).toString('utf8').replace(/^﻿/, '');
  } catch (error) { return fail(`could not be read (${(error as NodeJS.ErrnoException).code ?? 'read error'}).`); }
  finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
  if (!text.trim()) return fail('is empty. It must be JSON like {"models": [{"slug": "…"}]}.');
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) { return fail(`is not valid JSON (${jsonWhere(text, error)}).`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(`must be a JSON object with a "models" array; it holds ${kind(data)}.`);
  const catalog = data as {models?: unknown; reports_incremental_input?: unknown};
  if (!('models' in catalog)) return fail(`has no top-level "models" field (top-level keys: ${Object.keys(catalog).slice(0, 8).join(', ') || 'none'}).`);
  if (!Array.isArray(catalog.models)) return fail(`has a "models" field that is ${kind(catalog.models)}, not an array.`);
  if (!catalog.models.length) return fail('has an empty "models" array.');
  const id = (entry: unknown) => { const value = entry && typeof entry === 'object' ? (entry as {slug?: unknown; model?: unknown; id?: unknown}) : undefined; return value?.slug ?? value?.model ?? value?.id; };
  if (!catalog.models.some(entry => typeof id(entry) === 'string' && (id(entry) as string).trim())) {
    const first = catalog.models[0];
    return fail(`lists ${catalog.models.length} entr${catalog.models.length === 1 ? 'y' : 'ies'}, but none has a "slug" string (models[0] is ${kind(first)}${first && typeof first === 'object' && !Array.isArray(first) ? ` with keys ${Object.keys(first).slice(0, 8).join(', ') || 'none'}` : ''}).`);
  }
  return {ok: true, models: catalog.models, incremental: catalog.reports_incremental_input === true};
}
