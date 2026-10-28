import React from 'react';
import type {Token} from './highlightProtocol';

/** The matches of an in-file Find, as offsets into the whole file's text, for the line that starts at `lineStart`. */
export interface FindMarks { starts: readonly number[]; length: number; current: number; lineStart: number }

/** Offsets of each line's first character in `lines.join('\n')`. */
export function lineStarts(lines: readonly string[]): number[] {
  const out: number[] = [];
  let offset = 0;
  for (const line of lines) { out.push(offset); offset += line.length + 1; }
  return out;
}

interface Piece { text: string; color?: string }
interface Range { from: number; to: number; index: number }

function rangesInLine(marks: FindMarks, textLength: number): Range[] {
  const {starts, length, lineStart} = marks;
  const lineEnd = lineStart + textLength;
  // Matches do not overlap and are as long as the query, so those ending after the line starts are contiguous in `starts`.
  let low = 0, high = starts.length;
  while (low < high) { const middle = (low + high) >>> 1; if (starts[middle] + length <= lineStart) low = middle + 1; else high = middle; }
  const ranges: Range[] = [];
  for (let index = low; index < starts.length && starts[index] < lineEnd; index++) {
    ranges.push({from: Math.max(starts[index], lineStart) - lineStart, to: Math.min(starts[index] + length, lineEnd) - lineStart, index});
  }
  return ranges;
}

const paint = (piece: Piece, key: number): React.ReactNode => piece.color ? <span key={key} style={{color: piece.color}}>{piece.text}</span> : <React.Fragment key={key}>{piece.text}</React.Fragment>;

/**
 * The inside of a source row: the line's syntax colours (plain text until they arrive, or when they do not describe
 * this exact text) with any Find matches laid over them. A match keeps the token colours of the text it covers; the
 * current match is the one `marks.current` names.
 */
export function lineContent(text: string, tokens?: readonly Token[], marks?: FindMarks): React.ReactNode {
  // Rows come from text split on \n, tokens from text split on \r?\n.
  const described = !!tokens && tokens.reduce((sum, token) => sum + token.content.length, 0) === text.replace(/\r$/, '').length;
  const base: readonly Token[] = described ? tokens : [{content: text}];
  const ranges = marks ? rangesInLine(marks, text.length) : [];
  if (!ranges.length) return base.map((token, index) => paint({text: token.content, color: token.color}, index));
  const out: React.ReactNode[] = [];
  let inside: React.ReactNode[] = [];
  let key = 0, position = 0, at = 0;
  const closeMark = () => {
    out.push(<mark key={`m${ranges[at].index}`} data-current={ranges[at].index === marks!.current}>{inside}</mark>);
    inside = [];
    at++;
  };
  for (const token of base) {
    let used = 0;
    while (used < token.content.length) {
      while (at < ranges.length && ranges[at].to <= position + used) closeMark();
      const range = ranges[at], absolute = position + used;
      const covered = range !== undefined && absolute >= range.from;
      const stop = Math.min(token.content.length, (covered ? range.to : range?.from ?? Infinity) - position);
      const node = paint({text: token.content.slice(used, stop), color: token.color}, key++);
      if (covered) inside.push(node); else out.push(node);
      used = stop;
    }
    position += token.content.length;
  }
  while (at < ranges.length && inside.length) closeMark();
  return out;
}
