export type FilePresentation = 'markdown' | 'json' | 'csv' | 'tsv' | 'image' | 'text' | 'document' | 'workbook';

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
