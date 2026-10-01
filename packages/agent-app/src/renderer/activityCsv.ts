/** Ledger Activity as CSV (C25). Cells that start with = + - or @ get a leading apostrophe so a spreadsheet never runs them as formulas. */
import type { WorkspaceRow } from '../shared/domains/paperclip-protocol.ts';

const cell = (value: unknown): string => {
  let text = value === null || value === undefined ? '' : String(value).replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export function activityCsv(rows: readonly WorkspaceRow[]): string {
  const header = ['Time', 'Source', 'Kind', 'What happened', 'Details', 'Project'];
  const lines = rows.map(r => [r.at ?? '', r.source, r.status ?? '', r.title, r.detail, r.projectId ?? ''].map(cell).join(','));
  return `${[header.map(cell).join(','), ...lines].join('\r\n')}\r\n`;
}
/** Downloads text as a file through the browser (works in the app and on the web). */
export function downloadText(name: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
