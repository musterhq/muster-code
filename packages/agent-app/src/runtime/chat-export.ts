/**
 * Shareable chat transcripts (Markdown, HTML or JSON). Chronology, tool summaries and
 * attachment names are kept; reasoning, raw tool output and file bytes are left
 * out, secret-looking strings are masked, and every omission is listed so the
 * reader knows the export is not the whole record.
 */
import type { Chat, ChatExport, Folder, Project, TimelineItem } from '../shared/protocol.ts';
import { SECRET_MASK, SECRET_PATTERNS, redactSecrets } from './secret-redaction.ts';
import { plural } from '../shared/wording.ts';

const MASK = SECRET_MASK;
export { SECRET_PATTERNS, redactSecrets };

interface ExportSource { chat: Chat; items: TimelineItem[]; folder?: Folder; project?: Project; exportedAt?: string }
interface Entry { at: string; kind: TimelineItem['kind']; text: string; status?: string; tool?: string; attachments?: string[] }


function names(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(entry => entry && typeof entry === 'object' && typeof (entry as {name?: unknown}).name === 'string' ? [(entry as {name: string}).name] : []) : [];
}

export type ChatExportFormat = 'markdown' | 'html' | 'json';
export const isChatExportFormat = (value: unknown): value is ChatExportFormat => value === 'markdown' || value === 'html' || value === 'json';
const EXTENSION: Record<ChatExportFormat, string> = { markdown: 'md', html: 'html', json: 'json' };

export function fileNameFor(chat: Pick<Chat, 'title'>, format: ChatExportFormat): string {
  const base = chat.title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase() || 'chat';
  return `${base}.${EXTENSION[format] ?? 'md'}`;
}

/** Every character that could open markup or break an attribute is an entity; the page carries no script. */
export const escapeHtml = (value: string): string => value.replace(/[&<>"'`]/g, char => `&#${char.charCodeAt(0)};`);

/** `redact: false` (share sheet, explicit choice) keeps secret-looking strings; secret answers to provider
 *  questions are always masked because they were entered as secrets. */
export function exportChat(source: ExportSource, format: ChatExportFormat, options: { redact?: boolean } = {}): ChatExport {
  const redacted = { value: 0 }, redact = options.redact !== false;
  const clean = (value: string) => redact ? redactSecrets(value, redacted) : value;
  let reasoning = 0, toolOutput = 0, files = 0, secretAnswers = 0, streaming = 0;
  const entries: Entry[] = [];
  for (const item of source.items) {
    if (item.kind === 'reasoning') { if (item.text.trim()) reasoning++; continue; }
    if (item.status === 'running' && (item.kind === 'assistant' || item.kind === 'tool')) streaming++;
    const attachments = names(item.data?.attachments);
    files += attachments.length;
    if (item.kind === 'tool') {
      const name = typeof item.data?.name === 'string' ? item.data.name : item.text.split('\n')[0] ?? 'Tool';
      if (typeof item.data?.output === 'string' && item.data.output.trim()) toolOutput++;
      entries.push({ at: item.createdAt, kind: 'tool', text: clean(name.slice(0, 2000)), tool: typeof item.data?.type === 'string' ? item.data.type : 'tool', ...(item.status ? { status: item.status } : {}) });
      continue;
    }
    let text = item.text;
    if (item.kind === 'question') {
      const questions = Array.isArray(item.data?.questions) ? item.data.questions as Array<{id?: unknown; question?: unknown; isSecret?: unknown}> : [];
      const answers = item.data?.answers && typeof item.data.answers === 'object' ? item.data.answers as Record<string, {answers?: unknown}> : {};
      text = questions.map(question => {
        const answer = typeof question.id === 'string' ? answers[question.id]?.answers : undefined;
        if (question.isSecret === true && answer) secretAnswers++;
        const shown = question.isSecret === true ? (answer ? MASK : '') : Array.isArray(answer) ? answer.join(', ') : '';
        return `${String(question.question ?? '')}${shown ? `\n→ ${shown}` : ''}`;
      }).join('\n\n') || text;
    }
    entries.push({ at: item.createdAt, kind: item.kind, text: clean(text), ...(item.status ? { status: item.status } : {}), ...(attachments.length ? { attachments: attachments.map(clean) } : {}) });
  }
  const omitted = [
    reasoning ? `${plural(reasoning, 'reasoning block')} (internal model reasoning)` : '',
    toolOutput ? `Raw output of ${plural(toolOutput, 'tool call')} (only the command or tool name is kept)` : '',
    files ? `Contents of ${plural(files, 'attached file')} (names are listed)` : '',
    secretAnswers ? `${plural(secretAnswers, 'secret answer')} to provider questions` : '',
    redacted.value ? `${plural(redacted.value, 'secret-looking string')} replaced with ${MASK}` : '',
    streaming ? `${plural(streaming, 'item')} still streaming when exported (partial)` : '',
    redact ? '' : 'Secret-looking strings were NOT redacted in this export',
  ].filter(Boolean);
  const exportedAt = source.exportedAt ?? new Date().toISOString();
  const { chat, folder, project } = source;
  const fileName = fileNameFor(chat, format);
  if (format === 'json') {
    const text = JSON.stringify({
      schemaVersion: 1, exportedAt, redacted: redact,
      chat: { id: chat.id, title: clean(chat.title), status: chat.status, model: chat.model, provider: chat.providerId ?? '', mode: chat.mode, updatedAt: chat.updatedAt, ...(folder ? { folder: folder.name } : {}), ...(project ? { project: project.name } : {}) },
      items: entries, omitted,
    }, null, 2) + '\n';
    return { text, omitted, fileName };
  }
  const label: Record<TimelineItem['kind'], string> = { user: 'You', assistant: 'Assistant', reasoning: 'Reasoning', tool: 'Tool', approval: 'Approval', question: 'Question', notice: 'Notice' };
  if (format === 'html') {
    const meta = [`Exported ${exportedAt}`, `Model ${chat.model}`, folder ? `Folder ${folder.name}` : 'No folder', project ? `Project ${project.name}` : ''].filter(Boolean).map(escapeHtml).join(' · ');
    const body = entries.map(entry => {
      if (entry.kind === 'tool') return `<p class="tool"><code>${escapeHtml(entry.text.replace(/\n/g, ' '))}</code>${entry.status && entry.status !== 'completed' ? ` (${escapeHtml(entry.status)})` : ''}</p>`;
      const status = entry.status && entry.kind !== 'user' && entry.kind !== 'assistant' ? ` · ${escapeHtml(entry.status)}` : '';
      return `<section class="${entry.kind}"><h2>${label[entry.kind]} · <time>${escapeHtml(entry.at)}</time>${status}</h2><div class="text">${escapeHtml(entry.text.trim()) || '<em>(empty)</em>'}</div>${entry.attachments?.length ? `<p class="attached">Attached: ${entry.attachments.map(escapeHtml).join(', ')}</p>` : ''}</section>`;
    });
    const title = escapeHtml(clean(chat.title));
    const text = ['<!doctype html>', '<html lang="en"><head><meta charset="utf-8">',
      // No network, no script: the file is inert wherever it is opened.
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
      '<meta name="viewport" content="width=device-width, initial-scale=1">', `<title>${title}</title>`,
      '<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#1d1d1f;background:#fff}@media(prefers-color-scheme:dark){body{color:#e8e8ea;background:#1b1b1d}}h2{font-size:13px;opacity:.7;margin:24px 0 6px}.text{white-space:pre-wrap;overflow-wrap:anywhere}.tool{font-size:13px;opacity:.8}.meta,.attached{font-size:13px;opacity:.7}</style>',
      '</head><body>', `<h1>${title}</h1>`, `<p class="meta">${meta}</p>`, ...body,
      ...(omitted.length ? ['<hr>', '<p><strong>Not included in this export</strong></p>', `<ul>${omitted.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`] : []),
      '</body></html>', ''].join('\n');
    return { text, omitted, fileName };
  }
  const lines = [`# ${clean(chat.title)}`, '', [`Exported ${exportedAt}`, `Model ${chat.model}`, folder ? `Folder ${folder.name}` : 'No folder', project ? `Project ${project.name}` : ''].filter(Boolean).join(' · '), ''];
  for (const entry of entries) {
    if (entry.kind === 'tool') { lines.push(`- \`${entry.text.replace(/`/g, 'ˋ').replace(/\n/g, ' ')}\`${entry.status && entry.status !== 'completed' ? ` (${entry.status})` : ''}`, ''); continue; }
    lines.push(`## ${label[entry.kind]} · ${entry.at}${entry.status && entry.kind !== 'user' && entry.kind !== 'assistant' ? ` · ${entry.status}` : ''}`, '', entry.text.trim() || '_(empty)_', '');
    if (entry.attachments?.length) lines.push(`Attached: ${entry.attachments.join(', ')}`, '');
  }
  if (omitted.length) lines.push('---', '', '**Not included in this export**', '', ...omitted.map(line => `- ${line}`), '');
  return { text: lines.join('\n'), omitted, fileName };
}
