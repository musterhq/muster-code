/**
 * What the connected server is called on screen (#890). A Multica server is "Multica"; a Paperclip or Muster Server connection keeps the
 * one product name, "Muster Server". Reads the workspace snapshot the hub already holds (its link says which kind of server it came from).
 */
import type { ServerBackendKind, WorkspaceSnapshot } from '../shared/domains/paperclip-protocol';
import { NAMES } from '../shared/workspace-names';
import { workspaceSnapshot } from './hubStore';

export const MULTICA_NAME = 'Multica';
const isMultica = (kind: ServerBackendKind | null | undefined) => kind === 'multica';
/** The full name ("Muster Server", or "Multica"). */
export function serverName(snapshot: WorkspaceSnapshot | null = workspaceSnapshot()): string { return isMultica(snapshot?.paperclip?.kind) ? MULTICA_NAME : NAMES.paperclip; }
/** The short form for group labels ("Acme · Server", or "Acme · Multica"). */
export function serverShort(snapshot: WorkspaceSnapshot | null = workspaceSnapshot()): string { return isMultica(snapshot?.paperclip?.kind) ? MULTICA_NAME : NAMES.server; }
/** The name for an org row that says which kind of server it is on. */
export function kindName(kind: ServerBackendKind | null | undefined): string { return isMultica(kind) ? MULTICA_NAME : NAMES.paperclip; }
