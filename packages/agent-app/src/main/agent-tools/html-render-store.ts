/**
 * Pages an agent showed inline with render_html, kept on disk so a reopened chat (or a restarted app) still draws them. Each
 * page is one JSON file under a random 128-bit id, bounded in size and number (oldest go first). Network access is a flag
 * here, set only by the person (or by a Full access chat at creation), never by the page or the agent's arguments alone.
 */
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {HTML_RENDER_MAX_BYTES, htmlRenderTitle, type HtmlRenderRecord, type HtmlRenderView} from '../../shared/html-render.ts';

const ID = /^[a-f0-9]{32}$/;
const MAX_PAGES = 400;

export class HtmlRenderStore {
  constructor(private dir: string, private maxPages = MAX_PAGES) {}
  private file(id: string): string { return path.join(this.dir, `${id}.json`); }

  create(input: {chatId: string; title: unknown; html: unknown; network?: unknown; allowNetwork?: boolean; maxBytes?: number}): HtmlRenderRecord {
    if (typeof input.html !== 'string' || !input.html.trim()) throw new Error('render_html needs the page in `html`.');
    const bytes = Buffer.byteLength(input.html);
    const max = input.maxBytes ?? HTML_RENDER_MAX_BYTES;
    if (bytes > max) throw new Error(input.maxBytes ? `This file is ${(bytes / 1_000_000).toFixed(1)} MB; previews take at most ${max / 1_000_000} MB. Serve it with a dev server and preview its URL instead.` : `This page is ${(bytes / 1000).toFixed(0)} KB; render_html takes at most ${HTML_RENDER_MAX_BYTES / 1000} KB. Write it to a file and use preview_open instead.`);
    const networkRequested = input.network === true;
    const record: HtmlRenderRecord = {id: randomBytes(16).toString('hex'), chatId: input.chatId, title: htmlRenderTitle(input.title), html: input.html,
      networkRequested, networkAllowed: networkRequested && input.allowNetwork === true, createdAt: new Date().toISOString()};
    fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
    fs.writeFileSync(this.file(record.id), JSON.stringify(record), {mode: 0o600});
    this.prune();
    return record;
  }

  get(id: unknown): HtmlRenderRecord | undefined {
    if (typeof id !== 'string' || !ID.test(id)) return undefined;
    try {
      const value = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as HtmlRenderRecord;
      return value && value.id === id && typeof value.html === 'string' ? value : undefined;
    } catch { return undefined; }
  }

  view(id: unknown): HtmlRenderView | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    const {chatId: _chat, ...view} = record;
    return view;
  }

  /** The person allowed network for this one page. A page that never asked for network cannot be given it. */
  allowNetwork(id: unknown): HtmlRenderView {
    const record = this.get(id);
    if (!record) throw new Error('This page is no longer available.');
    if (!record.networkRequested) throw new Error('This page did not ask for network access.');
    record.networkAllowed = true;
    fs.writeFileSync(this.file(record.id), JSON.stringify(record), {mode: 0o600});
    return this.view(record.id)!;
  }

  private prune(): void {
    let names: string[];
    try { names = fs.readdirSync(this.dir).filter(name => /^[a-f0-9]{32}\.json$/.test(name)); } catch { return; }
    if (names.length <= this.maxPages) return;
    const aged = names.map(name => { try { return {name, at: fs.statSync(path.join(this.dir, name)).mtimeMs}; } catch { return {name, at: 0}; } }).sort((a, b) => a.at - b.at);
    for (const {name} of aged.slice(0, names.length - this.maxPages)) { try { fs.rmSync(path.join(this.dir, name), {force: true}); } catch { /* next time */ } }
  }
}
