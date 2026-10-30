/**
 * #789: Muster's own office runtime (LibreOffice headless for Word, Excel, PowerPoint and OpenDocument files).
 * It is never bundled in the installer: a LibreOffice the user installed is used when present, otherwise a pinned,
 * checksummed official build is downloaded on first use into Muster's own data folder. Settings › Storage shows it.
 */
export type OfficeRuntimeSource = 'installed' | 'downloaded' | 'none';
export type OfficeRuntimePhase = 'idle' | 'downloading' | 'verifying' | 'installing';
export interface OfficeRuntimeStatus {
  /** Which copy chats use: the user's own LibreOffice, Muster's download, or none yet. */
  source: OfficeRuntimeSource;
  /** The soffice that would run; null when there is none. */
  path: string | null;
  /** LibreOffice version of that copy, when known. */
  version: string | null;
  /** Bytes on disk of Muster's downloaded copy; null for the user's own install or none. */
  bytes: number | null;
  /** Muster's downloaded copy, even when the user's own install is the one in use (so Settings can offer Remove). */
  downloaded: { version: string; bytes: number; path: string } | null;
  /** The build Muster downloads on this computer; null when there is none for this platform and processor. */
  pinned: { version: string; bytes: number; url: string } | null;
  phase: OfficeRuntimePhase;
  /** Bytes received of `total` while downloading, verifying or installing. */
  received?: number;
  total?: number;
  /** Bytes of an interrupted download kept to resume from. */
  partialBytes: number;
  /** Why the last download or install failed. */
  error?: string;
}
export interface OfficeCommands {
  'office.runtime.status': { input: Record<string, never>; output: OfficeRuntimeStatus };
  /** Starts the download in the background and returns at once; progress arrives as `officeRuntimeChanged` events. */
  'office.runtime.download': { input: Record<string, never>; output: OfficeRuntimeStatus };
  /** Deletes Muster's downloaded copy and any partial download. A LibreOffice the user installed is never touched. */
  'office.runtime.remove': { input: Record<string, never>; output: OfficeRuntimeStatus };
  /** The office libraries agent scripts import (docx, exceljs, pptxgenjs, pdf-lib, jszip, pdfjs-dist). */
  'office.libraries.status': { input: Record<string, never>; output: OfficeLibrariesStatus };
  /** Deletes the libraries Muster downloaded; the next office_setup installs them again. */
  'office.libraries.remove': { input: Record<string, never>; output: OfficeLibrariesStatus };
}
export interface OfficeLibrariesStatus {
  ready: boolean;
  /** local: linked from a source checkout; downloaded: Muster's own copy. */
  source: 'local' | 'downloaded' | 'none';
  /** Bytes on disk of the downloaded copy. */
  bytes: number | null;
  modules: string;
  node: string;
  versions: Record<string, string>;
  busy: boolean;
  error?: string;
}
export const OFFICE_COMMANDS = { 'office.runtime.status': true, 'office.runtime.download': true, 'office.runtime.remove': true, 'office.libraries.status': true, 'office.libraries.remove': true } as const satisfies Record<keyof OfficeCommands, true>;
export type OfficeEvent = { type: 'officeRuntimeChanged'; status: OfficeRuntimeStatus }
  /** What a chat's running muster_office tool is waiting on (a first download); null when it is done. */
  | { type: 'officeToolProgress'; chatId: string; message: string | null };
