import React from 'react';
import {AppWindow, Inbox, MessagesSquare, NotebookPen, Bot, Braces, File, FileArchive, FileAudio, FileCode, FileImage, FileLock, FileSpreadsheet, FileText, FileType, FileVideo, Files, Folder, FolderOpen, GitBranch, GitCompare, GitMerge, GitPullRequest, Globe, History, Monitor, Presentation, SquareTerminal, type LucideIcon} from 'lucide-react';
import type {WorkspaceTab} from '../store';
import {fileIcon, type FileIconKind} from './filePresentation';
import './file-type-icon.css';

const GLYPHS: Record<FileIconKind, LucideIcon> = {
  folder: Folder, markdown: FileText, json: Braces, typescript: FileCode, javascript: FileCode, css: FileType, html: Globe,
  image: FileImage, pdf: FileText, sheet: FileSpreadsheet, doc: FileText, slides: Presentation, archive: FileArchive,
  lock: FileLock, audio: FileAudio, video: FileVideo, code: FileCode, text: FileText, file: File,
};

/** Per-type file glyph with a quiet tone, shared by the tree, search results and resource tabs. */
export function FileTypeIcon({path, directory = false, open = false, size = 13, className = ''}: {path: string; directory?: boolean; open?: boolean; size?: number; className?: string}): React.ReactElement {
  if (directory) {
    const Glyph = open ? FolderOpen : Folder;
    return <Glyph size={size} aria-hidden="true" className={`file-type-icon ${className}`} data-tone="folder"/>;
  }
  const {kind, tone} = fileIcon(path);
  const Glyph = GLYPHS[kind];
  return <Glyph size={size} aria-hidden="true" className={`file-type-icon ${className}`} data-kind={kind} data-tone={tone}/>;
}

const KIND_GLYPHS: Record<Exclude<WorkspaceTab['kind'], 'file' | 'attachment'>, LucideIcon> = {
  diff: GitCompare, git: GitBranch, changes: GitCompare, files: Files, browser: Globe, processes: SquareTerminal, computer: Monitor, subagents: Bot, pullRequest: GitPullRequest, history: History, conflict: GitMerge,
  canvas: NotebookPen, sideChat: MessagesSquare, pluginUi: AppWindow, inbox: Inbox,
};

/** 13px glyph for a resource tab or a recently closed resource: kind glyph, or the file-type icon (also used for an
 * attachment tab, whose `path` carries its file name so it gets the same extension-based glyph as a workspace file). */
export function ResourceTabIcon({tab, className = 'workspace-tab-icon'}: {tab: Pick<WorkspaceTab, 'kind' | 'path' | 'title'>; className?: string}): React.ReactElement {
  if (tab.kind === 'file' || tab.kind === 'attachment') return <FileTypeIcon path={tab.path ?? tab.title} className={className}/>;
  const Glyph = KIND_GLYPHS[tab.kind];
  return <Glyph size={14} aria-hidden="true" className={className}/>;
}
