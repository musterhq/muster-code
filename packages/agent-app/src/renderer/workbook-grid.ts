export interface CellPosition {r: number; c: number}
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}
export function parseCellAddress(value: string, rows: number, columns: number): CellPosition | null {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(value.trim());
  if (!match) return null;
  const c = [...match[1].toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const r = Number(match[2]) - 1;
  return r < rows && c < columns ? {r, c} : null;
}
/** Quote tabs/newlines without changing formula-like text. Copy never executes cells. */
export function rangeText(rows: string[][], start: CellPosition, end: CellPosition): string {
  const escape = (value: string) => /[\t\r\n"]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  const lines: string[] = [];
  for (let r = Math.min(start.r, end.r); r <= Math.max(start.r, end.r); r++) {
    const cells: string[] = [];
    for (let c = Math.min(start.c, end.c); c <= Math.max(start.c, end.c); c++) cells.push(escape(rows[r]?.[c] ?? ''));
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}
