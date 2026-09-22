export type FilePresentation = 'markdown' | 'json' | 'csv' | 'tsv' | 'image' | 'text' | 'document' | 'workbook';

/** Turn host/bridge failures into actionable, non-leaky viewer copy. */
export function friendlyFileError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file|cannot find the path|realpath/i.test(raw)) {
    return 'This workspace folder is no longer available. Reopen the folder, then retry this resource.';
  }
  if (/EACCES|EPERM|permission denied|not permitted/i.test(raw)) {
    return 'Muster could not read this resource with the current access. Reopen it with an allowed workspace.';
  }
  return raw.replace(/^BridgeError:\s*/i, '').trim() || 'The resource could not be opened.';
}

/** One dispatch point; viewers share navigation, scope, refresh and failure UI. */
export function filePresentation(path: string): FilePresentation {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'xlsx') return 'workbook';
  if (['pdf','doc','docx','ppt','pptx','xls','odt','odp','ods'].includes(extension ?? '')) return 'document';
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown';
  if (extension === 'json' || extension === 'geojson') return 'json';
  if (extension === 'csv' || extension === 'tsv') return extension;
  if (['png','jpg','jpeg','gif','webp'].includes(extension ?? '')) return 'image';
  return 'text';
}

export function parseDelimited(text: string, separator: ',' | '\t'): {rows: string[][]; limited: boolean} {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false, closed = false, cells = 0;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const cell = () => { row.push(value); cells++; value = ''; closed = false; if (row.length > 100) throw new Error('Preview supports up to 100 columns. Open source to inspect this file.'); };
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i+1] === '"') {value += '"'; i++;}
      else if (character === '"') {quoted = false; closed = true;}
      else value += character;
    } else if (character === separator) cell();
    else if (character === '\n' || character === '\r') {
      cell(); rows.push(row); row = [];
      if (character === '\r' && text[i+1] === '\n') i++;
      if ((rows.length >= 2000 || cells >= 20000) && i < text.length-1) return {rows, limited: true};
    } else if (character === '"' && value === '' && !closed) quoted = true;
    else {
      if (closed || character === '"') throw new Error('Malformed quoted field. Open source to inspect this file.');
      value += character;
    }
  }
  if (quoted) throw new Error('Unterminated quoted field. Open source to inspect this file.');
  if (value || row.length || closed) {cell(); rows.push(row);}
  return {rows, limited: false};
}

/** Conservative display typing for plain-text tables. Preserve identifiers such as 0017 as text. */
export function delimitedCellType(value:string):'text'|'number'|'date'|'boolean'|'error' {
  if (/^(?:true|false)$/i.test(value)) return 'boolean';
  if (/^#[A-Z0-9/?!]+!?$/i.test(value)) return 'error';
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value))) return 'date';
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value))) return 'number';
  return 'text';
}
