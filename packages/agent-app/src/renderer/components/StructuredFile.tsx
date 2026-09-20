import React, {useMemo, useState} from 'react';
import {ChevronRight} from 'lucide-react';
import {MarkdownTable} from './MarkdownTable';
import {parseDelimited} from './filePresentation';

function JsonNode({value, name, depth = 0}: {value: unknown; name?: string; depth?: number}): React.ReactElement {
  const [open, setOpen] = useState(depth === 0);
  if (value === null || typeof value !== 'object') return <div className="json-value"><span>{name && `${name}: `}</span><code>{JSON.stringify(value)}</code></div>;
  const entries = Object.entries(value);
  return <div className="json-node">
    <button className="json-node-toggle" aria-expanded={open} onClick={() => setOpen(item => !item)}><ChevronRight size={12}/><span>{name && `${name}: `}{Array.isArray(value) ? 'Array' : 'Object'} · {entries.length}</span></button>
    {open && (depth >= 32 ? <p>Depth limit reached. View source for the full value.</p> : <div className="json-children">
      {entries.slice(0,100).map(([key, child]) => <JsonNode key={key} value={child} name={key} depth={depth+1}/>)}
      {entries.length > 100 && <p>Showing the first 100 entries. View source for all entries.</p>}
    </div>)}
  </div>;
}

export const StructuredFile = React.memo(function StructuredFile({text, kind}: {text: string; kind: 'json' | 'csv' | 'tsv'}) {
  const result = useMemo(() => {
    try {return {value: kind === 'json' ? JSON.parse(text) : parseDelimited(text, kind === 'csv' ? ',' : '\t'), error: ''};}
    catch (error) {return {value: null, error: error instanceof Error ? error.message : String(error)};}
  }, [text,kind]);
  if (result.error) return <div className="pane-error" role="status"><p>Cannot preview this {kind.toUpperCase()} file: {result.error}</p><p>Use Source to inspect the original content.</p></div>;
  if (kind === 'json') return <div className="structured-file" aria-label="JSON structure"><JsonNode value={result.value}/></div>;
  const table = result.value as ReturnType<typeof parseDelimited>;
  if (!table.rows.length) return <p className="file-empty">This table is empty.</p>;
  return <div className="structured-file" aria-label="Delimited file preview">
    <p className="file-format-note">{table.rows.length} rows · first row shown as column names</p>
    <MarkdownTable><thead><tr>{table.rows[0].map((cell,i)=><th key={i}>{cell}</th>)}</tr></thead>
      <tbody>{table.rows.slice(1).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody>
    </MarkdownTable>
    {table.limited && <p className="pane-truncated">Preview row or cell limit reached. View source for the available file content.</p>}
  </div>;
});
