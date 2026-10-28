/** Messages and limits shared by HighlightedCode (main thread) and syntax-highlight-worker (worker). */
export interface Token { content: string; color?: string }

/** A source this size or smaller is tokenised in one pass. */
export const WHOLE_SOURCE_LIMIT = 96 * 1024;
/** Largest source the worker will colour: twice the 512 KB file read limit, which leaves room for the removed
 *  lines an edited-file view adds to a file. Beyond this a view stays plain. */
export const MAX_HIGHLIGHT_SOURCE = 1024 * 1024;
/** Lines per block of a larger source. The worker tokenises one block at a time, carrying the grammar state from
 *  one block to the next, and lets its event loop run between blocks, so no single task is long. */
export const BLOCK_LINES = 256;

export interface LineBlock { start: number; rows: Token[][] }

/** Blocks `from`..`to` (inclusive, 0-based) of a document. The first request of a document carries its source;
 *  later ones omit it and the worker continues from the grammar state it kept. */
export interface BlocksRequest { type: 'blocks'; doc: number; id: number; language: string; from: number; to: number; source?: string }
export interface CloseRequest { type: 'close'; doc: number }

/** `blocks: null`: no grammar for the language, or the source is too big. `missing`: the worker no longer holds the
 *  document (it released its highlighter or was restarted), so the caller starts it again from the source. */
export type BlocksResponse = { id: number; blocks: LineBlock[] | null } | { id: number; missing: true };
