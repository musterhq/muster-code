import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Menu} from '@base-ui/react/menu';
import { AlertTriangle, Check, ChevronDown, FolderGit2, GitBranch, Globe, Laptop, Loader2, Monitor, RefreshCw, SquarePen, TerminalSquare, Upload } from 'lucide-react';
import type {Chat, ContextTelemetry, Folder, Project} from '../../shared/protocol';
import type {GitRepoInfo, GitWorktree} from '../../shared/domains/git-protocol';
import type {ChatEnvironmentStatus} from '../../shared/domains/sandbox-protocol';
import {invoke, subscribe} from '../bridge';
import {createChat, notifyError, notifySuccess} from '../store';
import {openSandbox} from '../sandboxScope';
import {ContextMeter} from './ContextMeter';
import {BranchPicker, type BranchMode} from './BranchPicker';
import {SandboxApplySheet} from './SandboxApplySheet';
import './environment-footer.css';

export const SANDBOX_ENV_LABEL = 'Sandbox · Linux container';
export const HOST_ENV_LABEL = 'This Mac';

/** Where the chat's agent runs (SBX-01); refreshed on domain events, on container activity and on window focus. */
export function useChatEnvironment(chatId: string): {environment: ChatEnvironmentStatus | undefined; refresh: () => void} {
  const [environment, setEnvironment] = useState<ChatEnvironmentStatus>();
  const token = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++token.current;
    invoke('sandbox.chatEnvironment.get', {chatId}).then(value => { if (mine === token.current) setEnvironment(value); }, () => {});
  }, [chatId]);
  useEffect(() => {
    setEnvironment(undefined); refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => {
      if (event.type === 'sandboxEnvironment') { if (event.chatId === chatId) setEnvironment(event.environment); return; }
      // Container events arrive on the same channel outside AgentEvent (as ScopedComputerTab reads them).
      const type = (event as {type: string}).type;
      if (type !== 'computerExecution' && type !== 'computerProgress' && type !== 'computerServices') return;
      clearTimeout(timer); timer = setTimeout(refresh, 300);
    });
    window.addEventListener('focus', refresh);
    return () => { off(); clearTimeout(timer); window.removeEventListener('focus', refresh); token.current++; };
  }, [chatId, refresh]);
  return {environment, refresh};
}

/** SBX-11: where the agent's browser runs for a sandbox chat. */
async function setBrowserPlacement(chatId: string, browser: 'host' | 'sandbox'): Promise<void> {
  try { await invoke('sandbox.browserPlacement.set', {chatId, browser}); } catch (cause) { notifyError(cause); }
}
/** Plain-language label for where the browser runs, including the in-sandbox service's state. */
export function browserPlacementLabel(environment: Pick<ChatEnvironmentStatus, 'browser' | 'browserService'> | undefined): string {
  if (environment?.browser !== 'sandbox') return 'Browser runs on this Mac';
  const state = environment.browserService?.state;
  const detail = state === 'running' ? 'running' : state === 'backoff' ? 'restarting' : state === 'failed' || state === 'lost' || state === 'exited' ? 'not running' : state === 'not-registered' ? 'not set up' : state ?? 'starting';
  return `Browser runs in the sandbox · ${detail}`;
}

async function setEnvironment(chatId: string, env: 'host' | 'sandbox'): Promise<void> {
  try { await invoke('sandbox.chatEnvironment.set', {chatId, env, mode: 'copy'}); } catch (cause) { notifyError(cause); }
}

/** Network-free repo facts (branch, last fetch, worktree-ness) kept fresh on workspace changes and window focus. */
export function useGitInfo(folderId: string | undefined): {info: GitRepoInfo | undefined; failed: boolean; refresh: () => void} {
  const [info, setInfo] = useState<GitRepoInfo>();
  const [failed, setFailed] = useState(false);
  const token = useRef(0);
  const refresh = useCallback(() => {
    if (!folderId) return;
    const mine = ++token.current;
    invoke('git.info', {folderId}).then(value => { if (mine === token.current && value) { setInfo(value); setFailed(false); } },
      () => { if (mine === token.current) { setInfo(undefined); setFailed(true); } });
  }, [folderId]);
  useEffect(() => {
    setInfo(undefined); setFailed(false);
    if (!folderId) return;
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => {
      if (event.type !== 'workspaceChanged' || event.folderId !== folderId) return;
      clearTimeout(timer); timer = setTimeout(refresh, 250);
    });
    window.addEventListener('focus', refresh);
    return () => { off(); clearTimeout(timer); window.removeEventListener('focus', refresh); token.current++; };
  }, [folderId, refresh]);
  return {info, failed, refresh};
}

async function chatInWorktree(entry: GitWorktree): Promise<void> {
  try {
    const folderId = entry.folderId ?? (await invoke('folder.add', {path: entry.path})).id;
    await createChat(folderId);
  } catch (cause) { notifyError(cause); }
}

/**
 * Where this chat runs: this Mac (the folder's checkout), another worktree of the
 * repository (starts a chat there), or the scoped sandbox shell. Shared by the
 * composer footer and the summary card.
 */
export function EnvironmentMenu({chat, project, folder, info, environment, className, children, side = 'top', align = 'start', onNewWorktree, onApply}: {
  chat: Pick<Chat, 'id' | 'title'> & {status?: Chat['status']}; project?: Pick<Project, 'id' | 'name'>; folder?: Pick<Folder, 'id'>; info?: GitRepoInfo; environment?: ChatEnvironmentStatus;
  className: string; children: React.ReactNode; side?: 'top' | 'bottom'; align?: 'start' | 'end'; onNewWorktree?: () => void; onApply?: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const inSandbox = environment?.env === 'sandbox';
  const busy = chat.status === 'running' || chat.status === 'stopping';
  const lock = busy ? 'Stop the chat before changing where it runs' : undefined;
  const [worktrees, setWorktrees] = useState<GitWorktree[]>();
  const [loading, setLoading] = useState(false);
  // Handing off to the branch picker: don't pull focus back to this trigger, or the picker would lose it and close.
  const handoff = useRef(false);
  useEffect(() => {
    if (!open || !folder || !info) return;
    let alive = true;
    setLoading(true);
    invoke('git.worktree.list', {folderId: folder.id}).then(value => { if (alive) setWorktrees(value ?? []); }, () => { if (alive) setWorktrees([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, folder?.id, !!info]);
  const list = info && worktrees?.length ? worktrees : undefined;
  return <Menu.Root open={open} onOpenChange={setOpen}>
    <Menu.Trigger className={className} aria-label="Where this chat runs">{children}</Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner side={side} align={align} sideOffset={6} className="env-menu-positioner">
        <Menu.Popup className="env-menu" data-native-preview-overlay finalFocus={() => { const keep = !handoff.current; handoff.current = false; return keep; }}>
          <Menu.Group>
            <Menu.GroupLabel className="env-menu-label">Run this chat on</Menu.GroupLabel>
            <Menu.Item className="env-menu-item" disabled={busy} title={lock ?? 'The chat’s folder on this computer'} onClick={() => { if (inSandbox) void setEnvironment(chat.id, 'host'); }}>
              <Laptop size={14}/><span className="env-menu-text">{HOST_ENV_LABEL}</span>{info && <span className="env-menu-detail">{info.worktree ? 'worktree' : info.branch ?? 'detached'}</span>}
              {!inSandbox ? <Check size={13} className="env-menu-check" aria-label="Current"/> : null}
            </Menu.Item>
            <Menu.Item className="env-menu-item" disabled={busy} title={lock ?? 'Commands and edits run inside a Linux container on an isolated copy of the folder; host access becomes read-only'} onClick={() => { if (!inSandbox) void setEnvironment(chat.id, 'sandbox'); }}>
              <Monitor size={14}/><span className="env-menu-text">Sandbox</span><span className="env-menu-detail">Linux container · isolated copy</span>
              {inSandbox ? environment?.ready ? <Check size={13} className="env-menu-check" aria-label="Current"/> : <AlertTriangle size={13} className="env-menu-warn" aria-label="Container not running"/> : null}
            </Menu.Item>
            {inSandbox && !environment?.ready && <div className="env-menu-note" role="note">{environment?.reason ?? 'The container is not running.'}</div>}
            {inSandbox && <>
              <div className="env-menu-separator" role="separator"/>
              <Menu.GroupLabel className="env-menu-label">Browser</Menu.GroupLabel>
              <Menu.Item className="env-menu-item" disabled={busy} title={lock ?? 'The agent browser runs on this Mac'} onClick={() => { if (environment?.browser === 'sandbox') void setBrowserPlacement(chat.id, 'host'); }}>
                <Laptop size={14}/><span className="env-menu-text">{HOST_ENV_LABEL}</span>
                {environment?.browser !== 'sandbox' ? <Check size={13} className="env-menu-check" aria-label="Current"/> : null}
              </Menu.Item>
              <Menu.Item className="env-menu-item" disabled={busy} title={lock ?? 'Headless Chromium runs as a supervised service inside this chat’s container; its DevTools port never leaves the container'} onClick={() => { if (environment?.browser !== 'sandbox') void setBrowserPlacement(chat.id, 'sandbox'); }}>
                <Globe size={14}/><span className="env-menu-text">In the sandbox</span><span className="env-menu-detail">headless · same container</span>
                {environment?.browser === 'sandbox' ? environment.browserService?.state === 'running' ? <Check size={13} className="env-menu-check" aria-label="Current"/> : <AlertTriangle size={13} className="env-menu-warn" aria-label="Browser service not running"/> : null}
              </Menu.Item>
              <div className="env-menu-note" role="note" data-testid="browser-placement"><Globe size={12} aria-hidden="true"/>{browserPlacementLabel(environment)}{environment?.browserService?.reason ? ` — ${environment.browserService.reason}` : ''}</div>
            </>}
            <Menu.Item className="env-menu-item" title="Open the container’s shell" onClick={() => openSandbox(chat, project)}>
              <TerminalSquare size={14}/><span className="env-menu-text">Sandbox shell</span><span className="env-menu-detail">Linux container</span>
            </Menu.Item>
            {inSandbox && folder && <>
              <Menu.Item className="env-menu-item" disabled={!onApply} title="Review the copy’s changes and apply them to the folder on this Mac" onClick={() => onApply?.()}>
                <Upload size={14}/><span className="env-menu-text">Apply changes to this Mac…</span>
              </Menu.Item>
              <Menu.Item className="env-menu-item" disabled={busy} title={lock ?? 'Replace the isolated copy with the folder’s current files'} onClick={() => invoke('sandbox.syncFromHost', {chatId: chat.id}).then(() => notifySuccess('Sandbox copy refreshed from this Mac.'), notifyError)}>
                <RefreshCw size={14}/><span className="env-menu-text">Refresh copy from this Mac</span>
              </Menu.Item>
            </>}
            {list && <>
              <div className="env-menu-separator" role="separator"/>
              <Menu.GroupLabel className="env-menu-label">Worktrees</Menu.GroupLabel>
              {list.map(entry => <Menu.Item key={entry.path} className="env-menu-item" disabled={entry.prunable} title={entry.current ? entry.path : `Start a new chat in ${entry.path}`}
                onClick={() => { if (!entry.current) void chatInWorktree(entry); }}>
                {entry.main ? <Laptop size={14}/> : <FolderGit2 size={14}/>}
                <span className="env-menu-text">{entry.main ? 'Main checkout' : entry.branch ?? 'Detached worktree'}</span>
                <span className="env-menu-detail">{entry.main ? entry.branch ?? 'detached' : entry.prunable ? 'missing' : 'worktree'}</span>
                {entry.current ? <Check size={13} className="env-menu-check" aria-label="Current"/> : <SquarePen size={13} className="env-menu-hint" aria-label="New chat"/>}
              </Menu.Item>)}
            </>}
            {loading && !list && <div className="env-menu-note" role="note"><Loader2 size={12} className="env-menu-spin" aria-label="Loading worktrees"/>Loading worktrees…</div>}
          </Menu.Group>
          {info && onNewWorktree && <>
            <div className="env-menu-separator" role="separator"/>
            <Menu.Item className="env-menu-item" onClick={() => { handoff.current = true; setTimeout(onNewWorktree); }}><FolderGit2 size={14}/><span className="env-menu-text">New worktree for a parallel chat…</span></Menu.Item>
          </>}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}

const NO_TELEMETRY: ContextTelemetry = {usedTokens: null, windowTokens: null, source: null, compacted: false, updatedAt: null};

/** Cursor-style footer under the composer: environment ▾ · branch ▾ … context meter. */
export function EnvironmentFooter({chat, folder, project, telemetry}: {chat: Chat; folder?: Folder; project?: Project; telemetry?: ContextTelemetry}): React.ReactElement {
  const {info} = useGitInfo(folder?.id);
  const {environment} = useChatEnvironment(chat.id);
  const [picker, setPicker] = useState<{open: boolean; mode: BranchMode}>({open: false, mode: 'switch'});
  const [applying, setApplying] = useState(false);
  const inSandbox = environment?.env === 'sandbox';
  const envLabel = inSandbox ? SANDBOX_ENV_LABEL : info?.worktree ? 'Worktree' : HOST_ENV_LABEL;
  const branch = info ? info.branch ?? 'Detached HEAD' : undefined;
  return <footer className="chat-context env-footer">
    <EnvironmentMenu chat={chat} project={project} folder={folder} info={info} environment={environment} className={`env-footer-trigger${inSandbox && !environment.ready ? ' is-warn' : ''}`}
      onNewWorktree={() => setPicker({open: true, mode: 'worktree'})} onApply={folder ? () => setApplying(true) : undefined}>
      {inSandbox ? <Monitor size={12} aria-hidden="true"/> : info?.worktree ? <FolderGit2 size={12} aria-hidden="true"/> : <Laptop size={12} aria-hidden="true"/>}
      <span>{envLabel}</span>{inSandbox && !environment.ready && <AlertTriangle size={11} aria-label="Container not running"/>}<ChevronDown size={11} className="env-footer-chevron" aria-hidden="true"/>
    </EnvironmentMenu>
    {folder && <SandboxApplySheet chatId={chat.id} folderId={folder.id} open={applying} onClose={() => setApplying(false)}/>}
    {folder && branch !== undefined && <>
      <span className="env-footer-dot" aria-hidden="true">·</span>
      <BranchPicker folder={folder} className="env-footer-trigger env-footer-branch" label={`Branch: ${branch}`} side="top"
        open={picker.open} mode={picker.mode} onOpenChange={open => setPicker(value => ({open, mode: open ? value.mode : 'switch'}))}>
        <GitBranch size={12} aria-hidden="true"/><span>{branch}</span><ChevronDown size={11} className="env-footer-chevron" aria-hidden="true"/>
      </BranchPicker>
    </>}
    <ContextMeter telemetry={telemetry ?? NO_TELEMETRY}/>
  </footer>;
}
