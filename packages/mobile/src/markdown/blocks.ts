/** Splits a reply into blocks for rendering (#326 phase 4): Markdown prose, fenced code, and fences that become cards
 *  (Mermaid diagrams and charts). Streaming-safe: a fence that is still open at the end is code in progress, and blocks
 *  before the last keep their text as the reply grows, so only the last one changes. */
export type CardKind = 'diagram' | 'chart';
export type Block = {kind: 'prose'; text: string} | {kind: 'code'; lang: string; code: string; open: boolean} | {kind: 'card'; card: CardKind; lang: string; code: string; open: boolean};

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const CARDS: Record<string, CardKind> = {mermaid: 'diagram', 'vega-lite': 'chart', vega: 'chart', chart: 'chart'};

export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let prose: string[] = [];
  const flush = () => { const body = prose.join('\n').replace(/^\n+|\n+$/g, ''); if (body) blocks.push({kind: 'prose', text: body}); prose = []; };
  const lines = text.split('\n');
  for (let at = 0; at < lines.length; at++) {
    const open = FENCE.exec(lines[at]!);
    if (!open) { prose.push(lines[at]!); continue; }
    flush();
    const marker = open[1]!, lang = (open[2] ?? '').toLowerCase(), body: string[] = [];
    let closed = false;
    for (at++; at < lines.length; at++) {
      const line = lines[at]!;
      if (line.trim().startsWith(marker[0]!.repeat(marker.length)) && /^\s*[`~]+\s*$/.test(line)) { closed = true; break; }
      body.push(line);
    }
    const code = body.join('\n'), card = CARDS[lang];
    blocks.push(card ? {kind: 'card', card, lang, code, open: !closed} : {kind: 'code', lang, code, open: !closed});
  }
  flush();
  return blocks;
}
export const sameBlock = (a: Block, b: Block): boolean => a.kind === b.kind && (a.kind === 'prose' ? a.text === (b as typeof a).text : a.code === (b as typeof a).code && a.lang === (b as typeof a).lang && a.open === (b as typeof a).open);
