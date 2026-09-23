import { ArrowUp, AtSign, BookmarkPlus, Boxes, Brain, Check, ChevronDown, CircleAlert, CircleDot, Cpu, FilePlus, FileText, Folder, FolderKanban, Gauge, GitBranch, GitCompare, Globe, Goal, Lightbulb, LoaderCircle, MessageSquarePlus, Monitor, MessagesSquare, Mic, Paperclip, PenLine, Pencil, Plus, Search, Server, Shrink, Sparkles, Square, SquarePen, SquareTerminal, Star, X, type LucideIcon } from 'lucide-react';
import { MemoryRecallChip } from './MemoryRecallChip';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_ATTACHED_SKILL_BYTES, REASONING_EFFORTS, type Chat, type FileEntry, type PluginEntry, type Project, type QueuedMessage, type ReasoningEffort, type SkillEntry } from '../../shared/protocol';
import { goalResumable } from '../../shared/domains/goals-protocol';
import { invoke } from '../bridge';
import { forkChat } from '../messageActions';
import { runMenuAction } from '../menuActions';
import { discardAttachment, listAttachments, previewAttachment, readFileBase64, runtimeMessage, stageAttachment } from '../composerBridge';
import { applyVisibility, modelBadges } from '../../shared/model-catalog';
import { useModelPolicy } from '../modelPolicy';
import { createChat, flushComposerDraft, getState, loadPlugins, loadProviders, loadSkills, notifyError, notifySuccess, openAppSettings, openBrowserTab, openFile, openPluginsScreen, openProjectsScreen, openTab, selectChat, sendMessage, setComposerDraft, setFollowUpMode, snapshotRevision, stopChat, updateChat } from '../store';
import { ADD_CONTEXT_EVENT, loadComposerMemory, normalizeContextChip, saveComposerMemory, serializeContext, type ContextChip } from '../composerContext';
import { setTerminalDock, setTerminalPaneView, terminalDock } from '../processSummary';
import { ChipMirror, ContextStrip, TokenCard } from './ComposerTokens';
import { useStore } from '../useStore';
import { AttachmentStrip, type ComposerAttachment } from './AttachmentStrip';
import { CaptureSourcePicker, type CaptureResult } from './CaptureSourcePicker';
import { accessibilityAttachment, utf8Base64 } from '../captureRegion';
import { ProviderUsageHover } from './ProviderUsage';
import type { ComputerCaptureSource } from '../../shared/domains/computer-protocol';
import { baseFileName, buildAddRows, buildMentionRows, buildSlashRows, ComposerMenuList, connectorEntries, firstRow, nextRow, pluginLabel, pluginRow, skillRow, skillUsable, type MenuRow } from './ComposerMenu';
import { ComposerQuestionPanel, useQuestionFlow } from './ComposerQuestionPanel';
import { ComposerInfoCard, type InfoView } from './ComposerInfoCard';
import { useRunningTerminals } from './composerTerminals';
import type { McpServer } from '../../shared/domains/mcp-protocol';
import { useWorkspaceSearch } from './ContextPicker';
import { PluginIcon } from './PluginIcon';
import { ProviderLogo } from './ProviderLogo';
import { fileVisual } from './fileVisual';
import { GoalEditor, GoalStrip } from './GoalStrip';
import { ProjectPicker } from './ProjectPicker';
import { RecordSkill, type SkillDraft } from './RecordSkill';
import { SKETCH_FILE_NAME, SketchPad, type SketchStroke } from './SketchPad';
import { ConfirmSheet } from './ConfirmSheet';
import { ACCESS_OPTIONS, FullAccessConfirm } from './FullAccessConfirm';
import { COMPOSER_COMMANDS, EFFORT_LABELS, SKILL_RECORDER_PROMPT, followUpAction, skillDraft, terminalText, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, attachmentKey, attachmentName, imageBlindModel, imageBlindWarning, chipPayload, chipToken, classifyPaste, configuredAccess, effectiveAccess, findChipRanges, findTokenRanges, formatBytes, insertToken, menuIndex, nextEffort, previewLimit, rankSections, readMentionQuery, readSlashQuery, saveFolderAccess, scoreItem, scoreQueryMatch, INIT_PROMPT, reviewPrompt, pendingQuestionItem, questionDigit, pluginPromptHint, terminalsPillLabel, skipsFullAccessConfirm, setFullAccessSkip, type ChipRange, type ComposerAccess, type ComposerChip, type ComposerCommandId, type TokenVocabulary } from './composerMenus';
import { QueuedMessages } from './QueuedMessages';
import { CheckoutQueueBanner, isCheckoutQueued, sendWithCheckoutGuard } from './ParallelRunGuard';
import { StashesPopover, usePromptStash } from './PromptStashes';
import './composer.css';
import './composer-s3a.css';
import { plural } from '../../shared/wording.ts';

const ACCESS = ACCESS_OPTIONS;
const COMMAND_ICONS: Record<ComposerCommandId, LucideIcon> = {plan:Lightbulb,goal:Goal,project:FolderKanban,sketch:PenLine,terminal:SquareTerminal,model:Cpu,reasoning:Brain,access:CircleAlert,new:SquarePen,browser:Globe,stop:Square,compact:Shrink,fork:GitBranch,rename:Pencil,status:Gauge,mcp:Server,init:FilePlus,review:GitCompare};
/** A terminal whose recent output can be attached: an owned command, or an interactive shell read through its replay ring. */
interface TerminalSource { key: string; label: string; read(): Promise<string> }
/** The chat's terminals with output, newest first: interactive shells, then owned commands. */
async function terminalSources(chatId: string): Promise<TerminalSource[]> {
  const [shells, commands] = await Promise.all([invoke('terminal.list', { chatId }).catch(() => []), invoke('processes.list', { chatId }).catch(() => ({ sessions: [] }))]);
  const shellRows: TerminalSource[] = (Array.isArray(shells) ? shells : []).slice().reverse().map(info => ({ key: info.id, label: `${info.title}${info.cwd ? ` · ${info.cwd.split('/').pop()}` : ''}`,
    read: async () => terminalText((await invoke('terminal.snapshot', { id: info.id })).data ?? '') }));
  const commandRows: TerminalSource[] = (Array.isArray(commands?.sessions) ? commands.sessions : []).filter(session => session.output).reverse().map(session => ({ key: session.processId, label: session.label || session.command || 'Command',
    read: async () => terminalText(session.output) }));
  return [...shellRows, ...commandRows];
}
const MODEL_FAVORITES_KEY = 'muster.composer.model-favorites.v1';
const EFFORT_KEY = 'muster.composer.effort.v1';
const PLUGIN_MRU_KEY = 'muster.composer.plugin-mru.v1';
const MENU_LIMIT = 8;
/** The + menu's default (no search text) plugin preview — pinned/recently-used first, then a "Browse
 * plugins" row for the rest, instead of dumping every installed plugin inline (there can be dozens). */
const PLUGIN_PREVIEW_LIMIT = 6;
const NO_QUEUE: QueuedMessage[] = [];
/** Web Speech dictation (Chromium exposes the prefixed constructor); the mic hides when absent. */
type Recognition = { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null };
const speechRecognition = (): (new () => Recognition) | undefined => typeof window === 'undefined' ? undefined : (window as unknown as Record<string, new () => Recognition>).SpeechRecognition ?? (window as unknown as Record<string, new () => Recognition>).webkitSpeechRecognition;
const DICTATION_ERRORS: Record<string, string> = { 'not-allowed': 'Microphone access was denied', 'service-not-allowed': 'Dictation is not available on this system', 'no-speech': 'No speech heard', network: 'Dictation needs a network connection', 'audio-capture': 'No microphone found' };
/** Paused goals the user chose to keep paused ("Keep paused"); not asked again this session. */
const resumeDeclined = new Set<string>();
/** Per-chat effort, loaded once; localStorage keeps it across restarts. */
let effortMemory: Record<string, ReasoningEffort> | null = null;

function readLocal<T>(key: string, fallback: T, valid: (value: unknown) => boolean): T {
  try { const value = JSON.parse(window.localStorage.getItem(key) ?? 'null'); return valid(value) ? value as T : fallback; } catch { return fallback; }
}
function writeLocal(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Preference stays for this session only. */ }
}
const isRecord = (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** F9: a chat started from the New-chat draft opens with the effort the draft showed (a resolved default or an
 *  explicit pick), so its composer label matches what the runtime applies instead of reverting to the model's own. */
export function seedChatEffort(chatId: string, effort: ReasoningEffort): void {
  const current: Record<string, ReasoningEffort> = effortMemory ??= readLocal<Record<string, ReasoningEffort>>(EFFORT_KEY, {}, isRecord);
  if (current[chatId]) return;
  effortMemory = { ...current, [chatId]: effort }; writeLocal(EFFORT_KEY, effortMemory);
}
const isStrings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');

/** A plain Enter inside a fenced block is editing, not submission. */
function insideFence(text: string, caret: number): boolean {
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.slice(0, caret).split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1][0];
    if (!fence) {
      if (marker !== '`' || !match[2].includes('`')) fence = { marker, length: match[1].length };
    } else if (marker === fence.marker && match[1].length >= fence.length && !match[2].trim()) {
      fence = undefined;
    }
  }
  return Boolean(fence);
}

function resizeComposer(field: HTMLTextAreaElement): void {
  const style = getComputedStyle(field);
  const maxHeight = parseFloat(style.maxHeight) || 200;
  const minHeight = parseFloat(style.minHeight) || 26;
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const top = field.scrollTop;
  field.style.height = '0px';
  const height = Math.max(minHeight, field.scrollHeight + border);
  field.style.height = `${Math.min(maxHeight, height)}px`;
  field.style.overflowY = height > maxHeight ? 'auto' : 'hidden';
  field.scrollTop = top;
}

/** Caret position of `index` inside the textarea, measured on a hidden mirror with the same text metrics. */
function caretPoint(field: HTMLTextAreaElement, index: number): { left: number; top: number } {
  const style = getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const name of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize'] as const) {
    const value = (style as unknown as Record<string, string | undefined>)[name];
    if (value) (mirror.style as unknown as Record<string, string>)[name] = value;
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' });
  mirror.textContent = field.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = '@';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const point = { left: Number(marker.offsetLeft) || 0, top: Number(marker.offsetTop) || 0 };
  mirror.remove();
  return point;
}

function humanizeModel(model: string): string {
  const value = model.trim().split('/').pop() ?? '';
  return value ? value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : 'Model unavailable';
}

/** Empty query: the folder's top level. Otherwise the debounced workspace search. Exported so the new-chat draft's
 *  own @ mention menu (CHAT-23) reuses the exact same file lookup instead of a second implementation. */
export function useMentionEntries(folderId: string | undefined, query: string, enabled: boolean): { entries: FileEntry[] | null; loading: boolean; error: string } {
  const search = useWorkspaceSearch(folderId, query, enabled);
  const [root, setRoot] = useState<{ folderId: string; entries: FileEntry[] } | null>(null);
  const empty = !query.trim();
  useEffect(() => {
    if (!enabled || !folderId || !empty || root?.folderId === folderId) return;
    let live = true;
    void invoke('files.list', { folderId, path: '' }).then(value => { if (live) setRoot({ folderId, entries: Array.isArray(value) ? value : [] }); }).catch(() => { if (live) setRoot({ folderId, entries: [] }); });
    return () => { live = false; };
  }, [enabled, folderId, empty]);
  return empty ? { entries: root && root.folderId === folderId ? root.entries : null, loading: false, error: '' } : search;
}

export function Composer({ chat }: { chat: Chat }): React.ReactElement {
  const state = useStore();
  const modEnter = state.settings['general.sendKey'] === 'mod-enter';
  const draft = state.composerDrafts[chat.id];
  const text = draft?.text ?? chat.draft;
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const programmatic = useRef(false);
  const recall = useRef<{ values: string[]; index: number } | null>(null);
  const recoveryNeeded = chat.recovery?.kind === 'recovery-needed';
  const running = chat.status === 'running' || chat.status === 'stopping';
  const stopping = chat.status === 'stopping';
  const sending = Boolean(state.sending[chat.id]);
  const sendError = state.sendErrors[chat.id];
  const project = state.snapshot?.projects.find(project => project.id === chat.projectId);
  const folderIds = project?.folderIds ?? (chat.folderId ? [chat.folderId] : []);
  const referenceFolders = (state.snapshot?.folders ?? []).filter(folder => folderIds.includes(folder.id));
  const folderId = chat.folderId ?? folderIds[0];
  const activeFolderPath = referenceFolders.find(folder => folder.id === chat.folderId)?.path;
  const composerRoot = useRef<HTMLDivElement>(null);
  const plusTrigger = useRef<HTMLButtonElement>(null);
  const plusMenu = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const savedSelection = useRef<{ start: number; end: number } | null>(null);
  const accessTrigger = useRef<HTMLButtonElement>(null);
  const cancelFull = useRef<HTMLButtonElement>(null);
  const accessMenu = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<'plus' | 'access' | 'project' | 'capture' | null>(null);
  const [captureSources, setCaptureSources] = useState<ComputerCaptureSource[]>([]);
  /** Composer tools opened from + or /: the goal editor (strip slot), Record a skill and Sketch dialogs. */
  const [panel, setPanel] = useState<{ kind: 'goal'; initial: string; mode: 'set' | 'edit' } | { kind: 'skill'; draft: SkillDraft } | { kind: 'sketch'; editing?: string } | { kind: 'info'; view: InfoView } | null>(null);
  /** Strokes behind each attached sketch (by attachment localId), so clicking its tile reopens it for editing. */
  const sketches = useRef(new Map<string, SketchStroke[]>());
  /** "Send message?" while the queue is paused, and Codex's "Resume paused goal?" after a send. */
  const [confirmSend, setConfirmSend] = useState(false);
  const [askResume, setAskResume] = useState(false);
  const [plusQuery, setPlusQuery] = useState('');
  const [plusActive, setPlusActive] = useState(0);
  const [terminals, setTerminals] = useState<TerminalSource[]>([]);
  /** User and detected MCP servers for the + menu's Connectors & MCP section (read when the menu opens). */
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  /** CS-B11: the oldest pending provider question, answered in the panel above the card with the textarea as its custom answer. */
  const questionFlow = useQuestionFlow(chat.id, pendingQuestionItem(state.timelines[chat.id]?.value));
  /** CS-A1-3: running shells and background commands of this chat, for the Terminals pill. */
  const runningTerminals = useRunningTerminals(chat.id);
  const [popoverActive, setPopoverActive] = useState(0);
  const [caret, setCaret] = useState(text.length);
  const [selection, setSelection] = useState({ start: text.length, end: text.length });
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Chips and context survive chat switches and reloads in this window (CHAT-05).
  const [chips, setChipsState] = useState<ComposerChip[]>(() => loadComposerMemory<ComposerChip>(chat.id).tokens);
  const setChips = (update: (current: ComposerChip[]) => ComposerChip[]) => setChipsState(current => { const next = update(current); saveComposerMemory(chat.id, { tokens: next }); return next; });
  const [contextChips, setContextState] = useState<ContextChip[]>(() => loadComposerMemory(chat.id).context);
  const setContext = (update: (current: ContextChip[]) => ContextChip[]) => setContextState(current => { const next = update(current); saveComposerMemory(chat.id, { context: next }); return next; });
  const [dictation, setDictation] = useState<{ interim: string } | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const backgroundPending = useRef(false);
  const backgroundAttempt = useRef<{ key: string; chatId: string; requestId: string } | null>(null);
  const [chipHover, setChipHover] = useState<{ index: number; left: number; top: number; start: number } | null>(null);
  const [fullConfirm, setFullConfirm] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsChanging, setSettingsChanging] = useState(false);
  const settingsPending = useRef(false);
  const settingsRequest = useRef(0);
  const modelRequest = useRef(0);
  const escapeAt = useRef(0);
  const currentDraft = useRef({ chatId: chat.id, text }); currentDraft.current = { chatId: chat.id, text };
  const selectedAccess = configuredAccess(chat);
  const actualAccess = effectiveAccess(chat);
  const planMode = chat.mode === 'plan';
  const shownAccess = planMode ? selectedAccess : actualAccess;
  const accessOption = ACCESS.find(option => option.id === shownAccess)!;
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef(attachments); attachmentsRef.current = attachments;
  const [dragging, setDragging] = useState(false);
  const [largePaste, setLargePaste] = useState<{ text: string; bytes: number; start: number; end: number } | null>(null);
  const [note, setNote] = useState('');
  const noteTimer = useRef(0);
  const [queueError, setQueueError] = useState('');
  const [queueing, setQueueing] = useState(false);
  const queuePending = useRef(false);
  const snapshotQueue = chat.queue ?? NO_QUEUE;
  const [optimisticQueue, setOptimisticQueue] = useState<QueuedMessage[]>([]);
  const queue = [...snapshotQueue, ...optimisticQueue.filter(item => !snapshotQueue.some(entry => entry.id === item.id))];
  const [forceStop, setForceStop] = useState(false);
  const [popoverAnchor, setPopoverAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [modelTab, setModelTab] = useState<string>('all');
  const [modelFavorites, setModelFavorites] = useState<string[]>(() => readLocal(MODEL_FAVORITES_KEY, [], isStrings));
  const [efforts, setEfforts] = useState<Record<string, ReasoningEffort>>(() => effortMemory ??= readLocal(EFFORT_KEY, {}, isRecord));
  const [pluginMru, setPluginMru] = useState<string[]>(() => readLocal(PLUGIN_MRU_KEY, [], isStrings));
  const [modelError, setModelError] = useState('');
  const [modelChanging, setModelChanging] = useState(false);
  const modelPending = useRef(false);
  const modelPopover = useRef<HTMLDivElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const providers = (state.providers.value ?? []).filter(provider => provider.available);
  const modelOptions = providers.flatMap(provider => provider.models.map(model => ({ ...model, provider: provider.name, providerId: provider.id })));
  const imageBlind = imageBlindModel(providers, chat.providerId, chat.model);
  // PRO-04: the user's visibility policy trims the picker; the chat's own model always stays listed.
  const modelPolicy = useModelPolicy();
  const { shown: pickerModels, hidden: hiddenModels } = applyVisibility(modelOptions, modelPolicy, { providerId: chat.providerId ?? 'hybrow', model: chat.model });
  const selectedModel = modelOptions.find(model => model.id === chat.model && model.providerId === (chat.providerId ?? 'hybrow'));
  const modelEfforts = selectedModel?.efforts ?? REASONING_EFFORTS;
  const storedEffort = efforts[chat.id];
  const effort: ReasoningEffort = storedEffort && modelEfforts.includes(storedEffort) ? storedEffort : selectedModel?.defaultEffort ?? 'medium';
  const favoriteKey = (model: { providerId: string; id: string }) => `${model.providerId}:${model.id}`;
  const visibleModels = pickerModels.filter(model => (modelTab === 'all' || (modelTab === 'favorites' ? modelFavorites.includes(favoriteKey(model)) : model.providerId === modelTab))
    && `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(modelQuery.trim().toLowerCase()))
    .sort((a, b) => a.provider.localeCompare(b.provider) || Number(modelFavorites.includes(favoriteKey(b))) - Number(modelFavorites.includes(favoriteKey(a))) || a.name.localeCompare(b.name));
  const skills = state.skills.value ?? [];
  const plugins = [...(state.plugins.value ?? [])].sort((a, b) => {
    const rank = (plugin: PluginEntry) => { const index = pluginMru.indexOf(plugin.name); return index < 0 ? Infinity : index; };
    return rank(a) - rank(b) || pluginLabel(a).localeCompare(pluginLabel(b));
  });
  const vocabulary: TokenVocabulary = {
    commands: COMPOSER_COMMANDS.map(command => ({ command: command.command, label: command.label })),
    skills: skills.filter(skillUsable).map(skill => ({ name: skill.name, id: skill.id, label: skill.displayName ?? skill.name })),
    plugins: plugins.map(plugin => ({ name: plugin.name, id: plugin.id, label: pluginLabel(plugin) })),
  };
  /** Picked chips move and delete as units; `tokenRanges` also paints recognised typed `/command`, `$skill` and `@plugin`. */
  const chipRanges = findChipRanges(text, chips);
  const tokenRanges = findTokenRanges(text, chips, vocabulary);
  /** CS-B3-6: a plugin chip's defaultPrompt[0], shown after the chips while nothing else is typed. */
  const promptHint = pluginPromptHint(text, tokenRanges, state.plugins.value ?? []);
  const chipAtCaret = chipRanges.find(range => caret > range.start && caret <= range.end);
  const popoverBlocked = composing.current || menu !== null || modelOpen || fullConfirm || dismissed === text;
  const slash = popoverBlocked ? null : readSlashQuery(text, caret);
  const mention = popoverBlocked || slash || chipAtCaret ? null : readMentionQuery(text, caret);
  const mentionQuery = mention?.query ?? '';
  const mentionEntries = useMentionEntries(folderId, mentionQuery, Boolean(mention));
  const readyAttachments = attachments.filter(item => item.state === 'ready' && item.ref);
  const readyIds = readyAttachments.map(item => item.ref!.id);
  const staging = attachments.some(item => item.state === 'staging');
  const hasPayload = Boolean(text.trim()) || readyIds.length > 0 || contextChips.some(chip => chip.type !== 'image');
  /** What leaves the composer: typed context as labelled fenced blocks, then the draft. */
  const outgoing = (value: string) => serializeContext(contextChips, value);
  /** Access and model may change mid-run (they apply to the next turn); plan mode waits for the run. */
  const settingsBlocked = sending || settingsChanging || modelChanging || recoveryNeeded;
  const choicesDisabled = running || settingsBlocked;
  const currentProvider = chat.providerId ?? 'hybrow';

  const closeInfo = React.useCallback(() => { setPanel(current => current?.kind === 'info' ? null : current); requestAnimationFrame(() => input.current?.focus()); }, []);
  const flash = (message: string) => {
    window.clearTimeout(noteTimer.current); setNote(message);
    noteTimer.current = window.setTimeout(() => setNote(''), 3500);
  };

  /** Programmatic edits go through the browser's editing pipeline so Cmd+Z can undo them. */
  const replaceRange = (start: number, end: number, insert: string, caretAfter = start + insert.length) => {
    const field = input.current;
    let applied = false;
    if (field) {
      field.focus(); field.setSelectionRange(start, end);
      programmatic.current = true;
      try { applied = typeof document.execCommand === 'function' && document.execCommand(insert ? 'insertText' : 'delete', false, insert); } catch { applied = false; }
      finally { programmatic.current = false; }
      if (applied && field.value !== `${text.slice(0, start)}${insert}${text.slice(end)}`) applied = false;
    }
    if (!applied) setComposerDraft(chat.id, `${text.slice(0, start)}${insert}${text.slice(end)}`);
    setCaret(caretAfter); setSelection({ start: caretAfter, end: caretAfter });
    requestAnimationFrame(() => { if (input.current) { input.current.focus(); input.current.setSelectionRange(caretAfter, caretAfter); } });
  };
  const restoreCaret = () => {
    const saved = savedSelection.current; savedSelection.current = null;
    requestAnimationFrame(() => { const field = input.current; if (!field) return; field.focus(); if (saved) field.setSelectionRange(Math.min(saved.start, field.value.length), Math.min(saved.end, field.value.length)); });
  };
  const currentRange = () => savedSelection.current ?? { start: input.current?.selectionStart ?? text.length, end: input.current?.selectionEnd ?? text.length };
  /** Insert a chip token (replacing `range`, or the saved/current selection) and remember what it refers to. */
  const insertChip = (chip: ComposerChip, range = currentRange()) => {
    const start = Math.min(range.start, text.length), end = Math.min(Math.max(range.end, start), text.length);
    const next = insertToken(text, chip.token, start, end);
    savedSelection.current = null; setMenu(null); setPlusQuery('');
    setChips(current => [...current.filter(entry => entry.token !== chip.token), chip]);
    replaceRange(next.start, next.end, next.insert, next.caret);
  };
  const removeChip = (range: ChipRange) => {
    const end = text[range.end] === ' ' ? range.end + 1 : range.end;
    setChipHover(null);
    replaceRange(range.start, end, '');
  };
  const pluginChip = (plugin: PluginEntry): ComposerChip => ({ token: chipToken('plugin', plugin.name), kind: 'plugin', id: plugin.id, label: pluginLabel(plugin) });
  const skillChip = (skill: SkillEntry): ComposerChip => ({ token: chipToken('skill', skill.name), kind: 'skill', id: skill.id, label: skill.displayName ?? skill.name });
  const invokePlugin = (plugin: PluginEntry, range?: { start: number; end: number }) => {
    const next = [plugin.name, ...pluginMru.filter(name => name !== plugin.name)].slice(0, 20);
    setPluginMru(next); writeLocal(PLUGIN_MRU_KEY, next);
    insertChip(pluginChip(plugin), range);
  };

  useEffect(() => { setPopoverActive(0); }, [slash?.query, slash?.start, mention?.query, mention?.start]);
  useLayoutEffect(() => {
    const field = input.current, root = composerRoot.current, start = slash?.start ?? mention?.start;
    if (start === undefined || !field || !root) { setPopoverAnchor(null); return; }
    const point = caretPoint(field, start);
    const n = (value: number) => Number.isFinite(value) ? value : 0;
    const top = n(field.offsetTop) + point.top - n(field.scrollTop);
    const width = Math.min(slash ? 400 : 380, n(root.clientWidth));
    setPopoverAnchor({ left: Math.max(0, Math.min(n(field.offsetLeft) + point.left - 10, n(root.clientWidth) - width)), bottom: Math.max(0, n(root.clientHeight) - top) + 6 });
  }, [slash?.start, mention?.start, Boolean(slash), Boolean(mention)]);
  // Any runtime snapshot after the add is authoritative (it omits `queue` when empty), so drop local rows then.
  const snapshotRev = snapshotRevision();
  useEffect(() => { setOptimisticQueue([]); }, [snapshotRev]);
  useEffect(() => {
    setForceStop(false);
    if (chat.status !== 'stopping') return;
    const timer = window.setTimeout(() => setForceStop(true), 4000);
    return () => window.clearTimeout(timer);
  }, [chat.status]);
  useEffect(() => () => {
    window.clearTimeout(noteTimer.current);
    for (const item of attachmentsRef.current) if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
  }, []);
  // Staged files survive reloads and chat switches in the runtime; restore them for this chat.
  useEffect(() => {
    let live = true;
    void listAttachments(chat.id).then(refs => {
      if (!live || !refs.length) return;
      setAttachments(current => [...current, ...refs.filter(ref => !current.some(item => item.ref?.id === ref.id)).map(ref => ({ localId: ref.id, key: `ref:${ref.id}`, name: ref.name, mime: ref.mime, size: ref.size, kind: ref.kind, state: 'ready' as const, ref }))]);
      // Always fetch a durable data: preview for a restored image, even if some stale (or blob:) previewUrl is already
      // set — a remount or restart never has a live blob left over, so anything but a data: URL here is unusable.
      for (const ref of refs) if (ref.kind === 'image') void previewAttachment(chat.id, ref.id).then(value => {
        if (live && value?.dataUrl) setAttachments(current => current.map(item => item.ref?.id === ref.id && !item.previewUrl?.startsWith('data:') ? { ...item, previewUrl: value.dataUrl } : item));
      }).catch(() => {});
    }).catch(() => { /* Runtimes without attachment staging have nothing to restore. */ });
    return () => { live = false; };
  }, [chat.id]);
  useEffect(() => {
    setMenu(null); setFullConfirm(false); setSettingsError(''); setDismissed(null); setCaret(text.length); recall.current = null; setModelQuery(''); setLargePaste(null);
    settingsRequest.current++; modelRequest.current++; settingsPending.current = false; modelPending.current = false; setSettingsChanging(false); setModelChanging(false);
  }, [chat.id]);
  useEffect(() => { if (running || sending) { setFullConfirm(false); setMenu(current => current === 'plus' ? current : null); } }, [running, sending]);
  // Skills and plugins load lazily the first time a picker needs them.
  const pickerOpen = menu === 'plus' || Boolean(slash) || Boolean(mention);
  useEffect(() => {
    if (!pickerOpen) return;
    if (state.plugins.phase === 'idle') void loadPlugins();
    if (state.skills.phase === 'idle') void loadSkills(true, activeFolderPath ? [activeFolderPath] : []);
  }, [pickerOpen]);
  useEffect(() => {
    if (menu !== 'plus') return;
    let live = true;
    void terminalSources(chat.id).then(value => { if (live) setTerminals(value); }).catch(() => { if (live) setTerminals([]); });
    void invoke('mcp.servers.list', undefined).then(value => { if (live) setMcpServers(Array.isArray(value) ? value : []); }).catch(() => { if (live) setMcpServers([]); });
    const frame = requestAnimationFrame(() => plusMenu.current?.focus());
    return () => { live = false; cancelAnimationFrame(frame); };
  }, [menu]);
  useEffect(() => {
    if (menu !== 'access') return;
    const frame = requestAnimationFrame(() => composerRoot.current?.querySelector<HTMLButtonElement>('.composer-access-menu button:not(:disabled)')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [menu]);
  // Outside pointer/focus closes whichever popover is open; typed popovers are dismissed for this exact draft.
  const anyPopover = Boolean(menu || modelOpen || slash || mention);
  useEffect(() => {
    if (!anyPopover) return;
    const inside = (target: EventTarget | null) => Boolean(composerRoot.current?.contains(target as Node));
    const close = () => { setMenu(null); setModelOpen(false); setDismissed(currentDraft.current.text); };
    const within = (target: Node, ...nodes: (HTMLElement | null)[]) => nodes.some(node => node?.contains(target));
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!inside(target)) { close(); return; }
      if (menu === 'plus' && !within(target, plusMenu.current, plusTrigger.current)) setMenu(null);
      if (menu === 'access' && !within(target, accessMenu.current, accessTrigger.current)) setMenu(null);
      if (menu === 'project' && !(target as Element).closest?.('.composer-project-popover,.composer-project')) setMenu(null);
      if (menu === 'capture' && !(target as Element).closest?.('.composer-capture-popover')) setMenu(null);
      if (modelOpen && !within(target, modelPopover.current, modelTrigger.current)) setModelOpen(false);
    };
    const focus = (event: FocusEvent) => { if (!inside(event.target)) close(); };
    document.addEventListener('pointerdown', pointer); document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('focusin', focus); };
  }, [anyPopover, modelOpen, menu]);

  // Keep the observer stable for the lifetime of this composer. Text changes
  // resize through the separate layout effect below; recreating an observer
  // for every keystroke causes needless work and can flicker on narrow panes.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    let width = field.clientWidth;
    const resize = () => { if (field.clientWidth !== width) { width = field.clientWidth; resizeComposer(field); } };
    resizeComposer(field);
    const observer = new ResizeObserver(() => { resize(); });
    observer.observe(field);
    return () => observer.disconnect();
  }, [chat.id]);
  useLayoutEffect(() => {
    if (input.current) resizeComposer(input.current);
    if (mirror.current && input.current) mirror.current.scrollTop = input.current.scrollTop;
  }, [text, tokenRanges.length]);
  useEffect(() => {
    const flush = () => { void flushComposerDraft(chat.id); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => { window.removeEventListener('beforeunload', flush); document.removeEventListener('visibilitychange', flush); flush(); };
  }, [chat.id]);
  useEffect(() => { if (state.providers.phase === 'idle') void loadProviders(); }, [state.providers.phase]);
  useEffect(() => {
    if (!modelOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setModelOpen(false); modelTrigger.current?.focus(); } };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [modelOpen]);
  useEffect(() => { setModelOpen(false); setModelError(''); }, [chat.id, sending]);

  const chooseModel = async (model: string, providerId: string) => {
    if (settingsBlocked || modelPending.current || settingsPending.current || (running && providerId !== currentProvider)) return;
    if (model === chat.model && providerId === currentProvider) { setModelOpen(false); modelTrigger.current?.focus(); return; }
    const request = ++modelRequest.current;
    setModelError(''); modelPending.current = true; setModelChanging(true);
    try {
      await invoke('chat.selectProvider', { id: chat.id, providerId, model });
      if (request === modelRequest.current && currentDraft.current.chatId === chat.id) { setModelOpen(false); if (running) flash('Model applies to the next turn'); requestAnimationFrame(() => modelTrigger.current?.focus()); }
    } catch (cause) {
      if (request === modelRequest.current && currentDraft.current.chatId === chat.id) setModelError(cause instanceof Error ? cause.message : 'Provider or model change was rejected. Your draft is unchanged.');
    } finally { if (request === modelRequest.current) { modelPending.current = false; setModelChanging(false); } }
  };
  const chooseEffort = (value: ReasoningEffort) => {
    const next = { ...efforts, [chat.id]: value };
    effortMemory = next; setEfforts(next); writeLocal(EFFORT_KEY, next);
    if (running) flash('Reasoning applies to the next turn');
  };
  const toggleModelFavorite = (key: string) => {
    setModelFavorites(current => { const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key]; writeLocal(MODEL_FAVORITES_KEY, next); return next; });
  };
  const onModelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = modelPopover.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)');
    if (!buttons?.length) return;
    event.preventDefault();
    const current = document.activeElement instanceof HTMLButtonElement ? [...buttons].indexOf(document.activeElement) : -1;
    buttons[event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1)]?.focus();
  };

  /** Sent attachments leave the strip without being discarded: the runtime now owns them. */
  const dropSent = (ids: string[]) => {
    for (const item of attachmentsRef.current) if (item.ref && ids.includes(item.ref.id) && item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
    setAttachments(current => current.filter(item => !item.ref || !ids.includes(item.ref.id)));
  };
  // CMP-19: stash the draft without sending (+ menu, ⌘⇧S) and restore it from the Stashes list (+ menu, ⌘K).
  const promptStash = usePromptStash({ chatId: chat.id, text, chips, context: contextChips, attachments, effort: storedEffort ? effort : undefined, disabled: chat.archived,
    setText: value => { setComposerDraft(chat.id, value); setCaret(value.length); }, setChips, setContext, setAttachments, chooseEffort, flash, notifyError });
  const clearIfUnchanged = (value: string) => { if (currentDraft.current.chatId === chat.id && currentDraft.current.text === value) { setComposerDraft(chat.id, ''); setCaret(0); } };

  /** Idle send. While the queue is paused Codex first asks "Send message?" (clear the queue or keep it). */
  const submit = (confirmed = false) => {
    // While the agent waits on a question, the composer text is its custom answer (the arrow is Next/Submit too).
    if (questionFlow && !questionFlow.collapsed) { void answerQuestion(); return; }
    if (!hasPayload || composing.current || sending || modelPending.current || settingsPending.current || chat.archived || recoveryNeeded) return;
    if (staging) { flash('Waiting for attachments to finish uploading'); return; }
    if (running) { void followUp(false); return; }
    if (!confirmed && chat.queuePaused && queue.length) { setConfirmSend(true); return; }
    if (isCheckoutQueued(chat.id)) { flash('Already queued · starts when the other chat in this folder finishes'); return; }
    recall.current = null;
    const ids = readyIds, payload = chipPayload(text, chips, vocabulary), goal = chat.goal, body = outgoing(text), extras = { ...payload, ...(storedEffort ? { effort } : {}) };
    // CHAT-06: another chat running in this checkout → worktree / queue / run anyway / cancel, before anything starts.
    void sendWithCheckoutGuard(chat.id, { hasAttachments: ids.length > 0 }, target => sendMessage(target, body, extras, target === chat.id ? ids : [])).then(sent => {
      if (!sent || currentDraft.current.chatId !== chat.id) return;
      setChips(() => []); setContext(() => []); dropSent(ids);
      // A paused goal: offer to resume it now that the user is back (Codex "Resume paused goal?").
      if (goal?.status === 'paused' && !resumeDeclined.has(`${chat.id}:${goal.createdAt}`)) setAskResume(true);
    });
  };
  const clearQueueAndSend = async () => {
    setConfirmSend(false);
    try { await invoke('chat.queue.clear', { id: chat.id }); } catch (cause) { setQueueError(runtimeMessage(cause)); return; }
    submit(true);
  };
  const answerResume = async (answer: 'resume' | 'keep' | 'later') => {
    setAskResume(false);
    const goal = chat.goal;
    if (!goal) return;
    if (answer === 'keep') resumeDeclined.add(`${chat.id}:${goal.createdAt}`);
    if (answer === 'resume') { try { await invoke('goals.resume', { chatId: chat.id }); flash('Goal resumed · continues when the chat is idle'); } catch (cause) { notifyError(cause); } }
    requestAnimationFrame(() => input.current?.focus());
  };
  /** While a turn runs: the Follow-up behavior setting decides, the invert shortcut flips it for this message. */
  const followUp = (inverted: boolean) => questionFlow && !questionFlow.collapsed ? answerQuestion() : followUpAction(state.followUpMode, inverted) === 'steer' ? steer() : queueFollowUp();
  /** Skill/plugin chips still in the text plus an explicitly chosen effort; they travel with queued and steered messages. */
  const chipExtras = () => { const payload = chipPayload(text, chips, vocabulary); return { ...(payload.skillIds.length ? { skillIds: payload.skillIds } : {}), ...(payload.pluginIds.length ? { pluginIds: payload.pluginIds } : {}), ...(storedEffort ? { effort } : {}) }; };
  const queueFollowUp = async (message = 'Queued · sends when this turn finishes') => {
    if (queuePending.current || !hasPayload || chat.archived || recoveryNeeded) return;
    if (staging) { flash('Waiting for attachments to finish uploading'); return; }
    const value = text, ids = readyIds, revision = snapshotRevision(), extras = chipExtras();
    queuePending.current = true; setQueueing(true); setQueueError('');
    try {
      const item = await invoke('chat.queue.add', { id: chat.id, text: outgoing(value), requestId: crypto.randomUUID(), ...(ids.length ? { attachmentIds: ids } : {}), ...extras });
      if (currentDraft.current.chatId !== chat.id) return;
      recall.current = null; clearIfUnchanged(value); dropSent(ids); setChips(() => []); setContext(() => []);
      // A snapshot already arrived after the add: it reflects the queue (the item may even have been dispatched).
      if (item && typeof item.id === 'string' && snapshotRevision() === revision) setOptimisticQueue(current => [...current, item]);
      flash(message);
    } catch (cause) {
      if (currentDraft.current.chatId === chat.id) setQueueError(runtimeMessage(cause));
    } finally { queuePending.current = false; setQueueing(false); }
  };
  const steer = async () => {
    if (queuePending.current || !hasPayload || chat.archived || recoveryNeeded) return;
    if (readyIds.length || staging) { await queueFollowUp('Queued: steering cannot carry attachments'); return; }
    const value = text, extras = chipExtras();
    queuePending.current = true; setQueueing(true); setQueueError('');
    let steered = false;
    let reason = '';
    try { const result = await invoke('chat.steer', { id: chat.id, text: outgoing(value), requestId: crypto.randomUUID(), ...extras }); steered = Boolean(result?.steered); reason = result?.reason ?? ''; }
    catch { steered = false; }
    finally { queuePending.current = false; setQueueing(false); }
    if (currentDraft.current.chatId !== chat.id) return;
    if (steered) { recall.current = null; clearIfUnchanged(value); setChips(() => []); setContext(() => []); flash('Sent to the running agent'); }
    else await queueFollowUp(reason ? `${reason} Queued instead.` : 'Queued: agent could not accept a steer right now');
  };

  /** Codex "Start in background" (⌥Enter): a new chat in the same folder, project and model gets this message; you stay here. */
  const startInBackground = async () => {
    if (!hasPayload || composing.current || sending || backgroundPending.current || chat.archived || recoveryNeeded) return;
    if (attachments.length) { flash('Attachments belong to this chat · send them here or remove them first'); return; }
    const value = text, extras = chipExtras(), body = outgoing(value);
    backgroundPending.current = true; setMenu(null);
    try {
      // CHAT-17: a retry of the same message reuses the chat it created and its requestId, so a reply lost after the
      // runtime accepted the send replays that run instead of starting a second chat or a second run.
      const key = `${chat.id}\0${body}`, previous = backgroundAttempt.current?.key === key ? backgroundAttempt.current : null;
      const reused = previous ? getState().snapshot?.chats.find(item => item.id === previous.chatId && !item.archived) : undefined, attempt = reused ? previous : null;
      const created = reused ?? await invoke('chat.create', { ...(chat.folderId ? { folderId: chat.folderId } : {}), ...(chat.projectId ? { projectId: chat.projectId } : {}) });
      const requestId = attempt?.requestId ?? crypto.randomUUID();
      backgroundAttempt.current = { key, chatId: created.id, requestId };
      if (created.model !== chat.model || (created.providerId ?? 'hybrow') !== currentProvider) await invoke('chat.selectProvider', { id: created.id, providerId: currentProvider, model: chat.model });
      await invoke('chat.send', { id: created.id, text: body, requestId, ...extras });
      backgroundAttempt.current = null;
      if (currentDraft.current.chatId === chat.id) { recall.current = null; clearIfUnchanged(value); setChips(() => []); setContext(() => []); }
      notifySuccess('Started in a new chat', { label: 'Open', run: () => selectChat(created.id) });
    } catch (cause) { notifyError(cause); }
    finally { backgroundPending.current = false; }
  };
  const Speech = speechRecognition();
  /** Final dictation joins the draft at the caret; interim words show in the placeholder or status line. */
  const dictated = useRef<(words: string) => void>(() => {});
  dictated.current = words => {
    const field = input.current, start = field?.selectionStart ?? text.length, end = field?.selectionEnd ?? start;
    const lead = start > 0 && !/\s$/.test(text.slice(0, start)) ? ' ' : '';
    replaceRange(start, end, `${lead}${words.trim()}`);
  };
  const toggleDictation = () => {
    if (recognition.current) { recognition.current.stop(); return; }
    if (!Speech) return;
    let engine: Recognition;
    try { engine = new Speech(); } catch (cause) { notifyError(cause); return; }
    engine.continuous = true; engine.interimResults = true; engine.lang = navigator.language || 'en-US';
    engine.onresult = event => {
      let final = '', interim = '';
      for (let index = event.resultIndex; index < event.results.length; index++) { const result = event.results[index]; if (result.isFinal) final += result[0].transcript; else interim += result[0].transcript; }
      setDictation({ interim });
      if (final.trim()) dictated.current(final);
    };
    engine.onerror = event => { if (event.error !== 'aborted') flash(DICTATION_ERRORS[event.error] ?? `Dictation stopped (${event.error})`); };
    engine.onend = () => { if (recognition.current === engine) recognition.current = null; setDictation(null); };
    recognition.current = engine;
    try { engine.start(); setDictation({ interim: '' }); input.current?.focus(); } catch (cause) { recognition.current = null; notifyError(cause); }
  };
  useEffect(() => () => { recognition.current?.abort(); recognition.current = null; }, [chat.id]);

  /** `muster:composer-add-context` (CMP-13): the focused chat's composer takes the chip and acknowledges with preventDefault(). */
  const takeContext = useRef<(event: Event) => void>(() => {});
  takeContext.current = event => {
    if (event.defaultPrevented || chat.archived) return;
    const chip = normalizeContextChip((event as CustomEvent).detail);
    if (!chip || (chip.chatId ?? getState().activeChatId) !== chat.id) return;
    event.preventDefault();
    if (chip.type === 'image' && chip.attachment) {
      const ref = { ...chip.attachment, chatId: chat.id, kind: 'image' as const, state: 'staged' };
      setAttachments(current => current.some(item => item.ref?.id === ref.id) ? current : [...current, { localId: ref.id, key: `ref:${ref.id}`, name: ref.name, mime: ref.mime, size: ref.size, kind: 'image', state: 'ready', ref, ...(chip.dataUrl ? { previewUrl: chip.dataUrl } : {}) }]);
      return;
    }
    // A skill or plugin the composer knows becomes its inline chip, so it travels as skillIds/pluginIds.
    const ref = String(chip.source.id ?? chip.id);
    const plugin = chip.type === 'plugin' ? plugins.find(entry => entry.id === ref || entry.name === ref) : undefined;
    const skill = chip.type === 'skill' ? skills.find(entry => entry.id === ref || entry.name === ref) : undefined;
    if (plugin) { invokePlugin(plugin, { start: text.length, end: text.length }); return; }
    if (skill) { insertChip(skillChip(skill), { start: text.length, end: text.length }); return; }
    setContext(current => [...current.filter(entry => entry.id !== chip.id), chip]);
    flash(`Added ${chip.label}`);
    requestAnimationFrame(() => input.current?.focus());
  };
  useEffect(() => {
    const listener = (event: Event) => takeContext.current(event);
    window.addEventListener(ADD_CONTEXT_EVENT, listener);
    return () => window.removeEventListener(ADD_CONTEXT_EVENT, listener);
  }, []);
  /** "Show source": the quoted message, the terminal or command it came from, or the file. */
  const openContextSource = (chip: ContextChip) => {
    const { source } = chip;
    const view = source.terminalId ? 'terminals' : source.processId ? 'commands' : source.kind === 'agent' ? 'agent' : null;
    if (view) {
      const owner = source.chatId ?? chat.id;
      if (view === 'terminals' && terminalDock().placement === 'panel') { setTerminalDock({ open: true }); return; }
      setTerminalPaneView(owner, view);
      openTab({ id: `processes:${owner}`, kind: 'processes', chatId: owner, title: 'Terminal' });
      return;
    }
    if (source.itemId) {
      const row = document.querySelector<HTMLElement>(`[data-item-id="${String(source.itemId).replace(/["\\]/g, '\\$&')}"]`);
      if (row) { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); row.classList.add('is-context-source'); window.setTimeout(() => row.classList.remove('is-context-source'), 1400); }
      else window.dispatchEvent(new CustomEvent('muster:reveal-item', { detail: { chatId: source.chatId ?? chat.id, itemId: source.itemId } }));
      return;
    }
    if (source.path) { const folder = typeof source.folderId === 'string' ? source.folderId : chat.folderId; if (folder) void openFile(folder, source.path, source.line); }
  };
  /** A quote whose message is gone from the loaded timeline (edited or forked away) is marked stale. */
  const loadedItems = state.timelines[chat.id]?.value;
  const shownContext = contextChips.map(chip => chip.type === 'quote' && chip.source.itemId && (chip.source.chatId ?? chat.id) === chat.id && loadedItems && !loadedItems.some(item => item.id === chip.source.itemId) ? { ...chip, stale: true } : chip);

  const updateAttachment = (localId: string, patch: Partial<ComposerAttachment>) => setAttachments(current => current.map(item => item.localId === localId ? { ...item, ...patch } : item));
  const stage = async (item: ComposerAttachment) => {
    if (!item.file) return;
    try {
      const ref = await stageAttachment({ chatId: chat.id, name: item.name, mime: item.mime, dataBase64: await readFileBase64(item.file) });
      if (!ref || typeof ref.id !== 'string') throw new Error('The runtime did not accept the file.');
      // Removed while uploading: release the runtime copy too.
      if (!attachmentsRef.current.some(entry => entry.localId === item.localId)) { void discardAttachment(chat.id, ref.id).catch(() => {}); return; }
      updateAttachment(item.localId, { state: 'ready', ref, kind: ref.kind === 'image' || ref.kind === 'file' ? ref.kind : item.kind, error: undefined });
      // The tile's preview is still the local blob: URL (or none at all); swap it for a durable data: URL the runtime
      // now owns, and only revoke the blob once that durable preview is in place — never before, so the tile is never
      // blank in between, and it keeps rendering correctly after a chat switch, remount or restart.
      if (ref.kind === 'image' && !item.previewUrl?.startsWith('data:')) {
        const blobUrl = item.previewUrl?.startsWith('blob:') ? item.previewUrl : undefined;
        try {
          const preview = await previewAttachment(chat.id, ref.id);
          if (preview?.dataUrl) {
            if (attachmentsRef.current.some(entry => entry.localId === item.localId)) updateAttachment(item.localId, { previewUrl: preview.dataUrl });
            if (blobUrl) URL.revokeObjectURL(blobUrl);
          }
        } catch { /* Durable preview is best-effort; the blob (if any) keeps the tile visible for this session. */ }
      }
    } catch (cause) { updateAttachment(item.localId, { state: 'failed', error: runtimeMessage(cause) }); }
  };
  /** Capture window (CUA-08): pick a window or screen, attach its screenshot as an image. */
  const captureWindow = async () => {
    setMenu(null); setPlusQuery('');
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) { notifyError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`); restoreCaret(); return; }
    try {
      const sources = await invoke('computer.captureSources', undefined);
      if (!sources.length) { flash('No windows or screens available to capture'); restoreCaret(); return; }
      setCaptureSources(sources); setMenu('capture');
    } catch (cause) { notifyError(cause); restoreCaret(); }
  };
  /** CUA-08: the picker hands over the (optionally cropped) capture and, when permitted, the window's text. */
  const chooseCapture = (capture: CaptureResult) => {
    setMenu(null);
    const stageOne = (item: { name: string; mime: string; kind: 'image' | 'file'; dataBase64: string; previewUrl?: string }) => {
      if (attachmentsRef.current.length >= MAX_ATTACHMENTS) { notifyError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`); return; }
      const localId = crypto.randomUUID();
      const staged: ComposerAttachment = { localId, key: `capture:${Date.now()}:${item.name}`, name: item.name, mime: item.mime, size: 0, kind: item.kind, state: 'staging', ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}) };
      attachmentsRef.current = [...attachmentsRef.current, staged]; setAttachments(attachmentsRef.current);
      void (async () => {
        try {
          const ref = await stageAttachment({ chatId: chat.id, name: item.name, mime: item.mime, dataBase64: item.dataBase64 });
          if (!attachmentsRef.current.some(entry => entry.localId === localId)) { void discardAttachment(chat.id, ref.id).catch(() => {}); return; }
          updateAttachment(localId, { state: 'ready', ref, size: ref.size, error: undefined });
        } catch (cause) { if (attachmentsRef.current.some(entry => entry.localId === localId)) updateAttachment(localId, { state: 'failed', error: runtimeMessage(cause) }); }
      })();
    };
    stageOne({ name: capture.name, mime: 'image/png', kind: 'image', dataBase64: capture.dataUrl.slice(capture.dataUrl.indexOf(',') + 1), previewUrl: capture.dataUrl });
    if (capture.accessibility) { const text = accessibilityAttachment(capture.name, capture.accessibility); stageOne({ name: text.name, mime: 'text/plain', kind: 'file', dataBase64: utf8Base64(text.text) }); }
    restoreCaret();
  };
  const addFiles = (files: File[]) => {
    const accepted: ComposerAttachment[] = [];
    let current = attachmentsRef.current, duplicate = 0;
    for (const file of files) {
      const key = attachmentKey(file);
      if (current.some(item => item.key === key) || accepted.some(item => item.key === key)) { duplicate++; continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { notifyError(`${file.name || 'File'} is ${formatBytes(file.size)}; attachments are limited to 20 MB each.`); continue; }
      if (current.length + accepted.length >= MAX_ATTACHMENTS) { notifyError(`You can attach up to ${MAX_ATTACHMENTS} files per message.`); break; }
      const kind = file.type.startsWith('image/') ? 'image' as const : 'file' as const;
      const previewUrl = kind === 'image' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
      accepted.push({ localId: crypto.randomUUID(), key, name: attachmentName(file, kind), mime: file.type || 'application/octet-stream', size: file.size, kind, state: 'staging', previewUrl, file });
    }
    if (duplicate && !accepted.length) flash(duplicate === 1 ? 'That file is already attached' : 'Those files are already attached');
    if (!accepted.length) return;
    current = [...current, ...accepted]; attachmentsRef.current = current;
    setAttachments(current);
    for (const item of accepted) void stage(item);
  };
  const removeAttachment = (localId: string) => {
    const item = attachmentsRef.current.find(entry => entry.localId === localId);
    if (!item) return;
    if (item.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
    sketches.current.delete(localId);
    attachmentsRef.current = attachmentsRef.current.filter(entry => entry.localId !== localId);
    setAttachments(attachmentsRef.current);
    if (item.ref) void discardAttachment(chat.id, item.ref.id).catch(notifyError);
    requestAnimationFrame(() => input.current?.focus());
  };
  const retryAttachment = (localId: string) => {
    const item = attachmentsRef.current.find(entry => entry.localId === localId);
    if (!item?.file) return;
    updateAttachment(localId, { state: 'staging', error: undefined });
    void stage({ ...item, state: 'staging' });
  };
  /** "Attach terminal": the terminal's last 200 lines join the message as a text file (Codex's read_thread_terminal context). */
  const attachTerminal = async (source?: TerminalSource) => {
    setMenu(null); setPlusQuery('');
    const chosen = source ?? (await terminalSources(chat.id).catch(() => []))[0];
    if (!chosen) { flash('No terminal output in this chat yet'); restoreCaret(); return; }
    try {
      const tail = await chosen.read();
      if (!tail.trim()) { flash('[terminal has no output yet]'); restoreCaret(); return; }
      addFiles([new File([`${tail}\n`], `terminal-${chosen.label.replace(/[^\w.-]+/g, '-').slice(0, 40)}.txt`, { type: 'text/plain', lastModified: Date.now() })]);
    } catch (cause) { notifyError(cause); }
    restoreCaret();
  };
  const openSketch = (editing?: string) => { setMenu(null); savedSelection.current = null; setPanel({ kind: 'sketch', ...(editing ? { editing } : {}) }); };
  /** A new sketch joins the strip; an edited one replaces its tile in place of the old PNG. */
  const attachSketch = (file: File, strokes: SketchStroke[], editing?: string) => {
    if (editing) removeAttachment(editing);
    const before = new Set(attachmentsRef.current.map(item => item.localId));
    addFiles([file]);
    const added = attachmentsRef.current.find(item => !before.has(item.localId) && item.name === SKETCH_FILE_NAME);
    if (added) sketches.current.set(added.localId, strokes);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    if (!data) return;
    let files = Array.from(data.files ?? []);
    if (!files.length && data.items) files = Array.from(data.items).flatMap(item => item.kind === 'file' ? [item.getAsFile()].filter((file): file is File => Boolean(file)) : []);
    if (files.length) { event.preventDefault(); addFiles(files); return; }
    const pasted = data.getData?.('text/plain') ?? '';
    if (pasted && classifyPaste(pasted) === 'large') {
      event.preventDefault();
      const field = event.currentTarget; setLargePaste({ text: pasted, bytes: new TextEncoder().encode(pasted).byteLength, start: field.selectionStart ?? text.length, end: field.selectionEnd ?? field.selectionStart ?? text.length });
    }
  };
  const resolveLargePaste = (as: 'attachment' | 'inline') => {
    const paste = largePaste; setLargePaste(null);
    if (!paste) return;
    if (as === 'inline') { replaceRange(Math.min(paste.start, text.length), Math.min(paste.end, text.length), paste.text); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    addFiles([new File([paste.text], `Pasted text ${stamp}.txt`, { type: 'text/plain', lastModified: Date.now() })]);
    requestAnimationFrame(() => input.current?.focus());
  };
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const openPlus = () => {
    setModelOpen(false); setSettingsError('');
    if (menu === 'plus') { setMenu(null); restoreCaret(); return; }
    const field = input.current; savedSelection.current = field ? { start: field.selectionStart ?? text.length, end: field.selectionEnd ?? field.selectionStart ?? text.length } : null;
    void loadSkills(true, activeFolderPath ? [activeFolderPath] : []); void loadPlugins();
    setPlusQuery(''); setPlusActive(0); setMenu('plus');
  };
  const openAccess = () => { setModelOpen(false); setSettingsError(''); setMenu(menu === 'access' ? null : 'access'); };
  const togglePlan = async () => {
    if (choicesDisabled || settingsPending.current || modelPending.current) { if (running) flash('Plan mode can change after this run finishes'); return; }
    const request = ++settingsRequest.current;
    settingsPending.current = true; setSettingsChanging(true); setSettingsError('');
    try {
      const accepted = await updateChat(chat.id, { mode: planMode ? 'agent' : 'plan' });
      if (request === settingsRequest.current && currentDraft.current.chatId === chat.id && !accepted) setSettingsError('Plan mode could not be changed. Your draft is unchanged.');
    } finally { if (request === settingsRequest.current) { settingsPending.current = false; setSettingsChanging(false); } }
  };
  const chooseAccess = async (permissionMode: ComposerAccess, acknowledgeFullAccess = false, rememberFolder = false) => {
    if (settingsBlocked || settingsPending.current || modelPending.current) return;
    if (permissionMode === selectedAccess && !acknowledgeFullAccess) { setMenu(null); accessTrigger.current?.focus(); return; }
    // CS-B7-3: a folder where the user chose "Don't ask again" switches straight to Full access (Settings › Chat undoes it).
    if (permissionMode === 'full' && !acknowledgeFullAccess) { if (skipsFullAccessConfirm(chat.folderId)) acknowledgeFullAccess = true; else { setMenu(null); setFullConfirm(true); return; } }
    const request = ++settingsRequest.current;
    settingsPending.current = true; setSettingsChanging(true); setSettingsError('');
    try {
      await invoke('chat.setPermissionMode', { id: chat.id, permissionMode, ...(acknowledgeFullAccess ? { acknowledgeFullAccess: true } : {}) });
      if (request !== settingsRequest.current || currentDraft.current.chatId !== chat.id) return;
      // Remembered so a second chat in the same folder starts with the access level this one settled on (CHAT-24).
      if (chat.folderId) saveFolderAccess(chat.folderId, permissionMode);
      if (rememberFolder && permissionMode === 'full') setFullAccessSkip(chat.folderId, true);
      setFullConfirm(false); setMenu(null); if (running) flash('Access applies to the next turn'); requestAnimationFrame(() => accessTrigger.current?.focus());
    } catch (cause) { if (request === settingsRequest.current && currentDraft.current.chatId === chat.id) setSettingsError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === settingsRequest.current) { settingsPending.current = false; setSettingsChanging(false); } }
  };
  /** The goal editor opens prefilled with the draft (minus a `/goal` token); with an empty draft it edits the unfinished goal. */
  const openGoal = (range?: { start: number; end: number }) => {
    if (chat.archived) return;
    setMenu(null); setModelOpen(false);
    const draftText = (range ? `${text.slice(0, range.start)}${text.slice(range.end)}` : text).trim();
    if (!draftText && chat.goal && chat.goal.status !== 'complete') { setPanel({ kind: 'goal', initial: chat.goal.text, mode: 'edit' }); return; }
    setPanel({ kind: 'goal', initial: draftText, mode: 'set' });
  };
  const goalDone = (saved: boolean, initial: string) => {
    setPanel(null);
    if (saved) { if (initial && currentDraft.current.text.trim() === initial) { setComposerDraft(chat.id, ''); setCaret(0); } flash(running ? 'Goal set · pursues after this turn' : 'Goal set · pursuing'); }
    requestAnimationFrame(() => input.current?.focus());
  };
  const projects = state.snapshot?.projects ?? [];
  const timelineItems = state.timelines[chat.id]?.value;
  /** Only a chat without messages moves; otherwise a new chat opens in the chosen project. */
  const movesToProject = !running && Boolean(timelineItems) && !timelineItems!.some(item => item.kind === 'user');
  const chooseProject = async (next: Project | null) => {
    setMenu(null);
    if ((next?.id ?? undefined) === chat.projectId) { restoreCaret(); return; }
    if (movesToProject) { if (await updateChat(chat.id, { projectId: next?.id ?? null })) flash(next ? `Working in ${next.name}` : 'Removed from the project'); restoreCaret(); return; }
    if (!next) return;
    await createChat(chat.folderId && next.folderIds.includes(chat.folderId) ? chat.folderId : next.folderIds[0], next.id);
  };
  /** Codex "Record a skill": a new conversation seeded with the recorder prompt, in the same folder and project. */
  const recordSkill = async () => {
    setMenu(null);
    if (await createChat(chat.folderId, chat.projectId, { draft: SKILL_RECORDER_PROMPT })) flash('Recording a skill · send to start the interview');
  };
  const openSaveSkill = () => { setMenu(null); setPanel({ kind: 'skill', draft: skillDraft(timelineItems ?? []) }); };
  const skillSaved = (slug: string) => {
    setPanel(null);
    void loadSkills(true, activeFolderPath ? [activeFolderPath] : []);
    flash(`Saved skill $${slug} · find it under / and +`);
    requestAnimationFrame(() => input.current?.focus());
  };
  const commandDisabled = (id: ComposerCommandId) => id === 'stop' ? !running : id === 'plan' ? choicesDisabled : id === 'model' || id === 'access' ? settingsBlocked : id === 'goal' || id === 'project' || id === 'sketch' || id === 'terminal' ? chat.archived : id === 'compact' ? running || !chat.providerThreadId : id === 'init' || id === 'review' ? chat.archived || !chat.folderId : false;
  const runCommand = (id: ComposerCommandId, range?: { start: number; end: number }) => {
    if (commandDisabled(id)) return;
    if (range) replaceRange(range.start, range.end, '');
    setMenu(null); setModelOpen(false);
    if (id === 'plan') void togglePlan();
    else if (id === 'goal') { const initial = (range ? `${text.slice(0, range.start)}${text.slice(range.end)}` : text).trim(); setPanel({ kind: 'goal', initial, mode: 'set' }); }
    else if (id === 'project') { savedSelection.current = null; setMenu('project'); }
    else if (id === 'sketch') openSketch();
    else if (id === 'terminal') void attachTerminal();
    else if (id === 'model' || id === 'reasoning') { setModelTab('all'); setModelOpen(true); }
    else if (id === 'access') setMenu('access');
    else if (id === 'new') void createChat(chat.folderId, chat.projectId);
    else if (id === 'browser') openBrowserTab();
    else if (id === 'stop') void stopChat(chat.id);
    else if (id === 'compact') void invoke('chat.compact', { id: chat.id }).catch(notifyError);
    else if (id === 'fork') void forkChat(chat.id);
    else if (id === 'rename') runMenuAction('rename-chat');
    else if (id === 'status' || id === 'mcp') { setPanel({ kind: 'info', view: id }); if (id === 'mcp' && state.plugins.phase === 'idle') void loadPlugins(); }
    else if (id === 'init') void runInit();
    else if (id === 'review') void runReview();
  };
  /** A built-in command's prompt goes out like a typed message: now when idle, queued behind the running turn otherwise. */
  const sendCommandPrompt = async (prompt: string, note: string) => {
    if (running) {
      try { await invoke('chat.queue.add', { id: chat.id, text: prompt, requestId: crypto.randomUUID() }); flash(`${note} · queued for after this turn`); } catch (cause) { setQueueError(runtimeMessage(cause)); }
      return;
    }
    if (await sendMessage(chat.id, prompt, {}, [])) flash(note);
  };
  /** `/init` (Codex): the agent writes AGENTS.md for this folder; an existing AGENTS.md is never overwritten. */
  const runInit = async () => {
    if (!chat.folderId) return;
    const exists = await invoke('files.read', { folderId: chat.folderId, path: 'AGENTS.md' }).then(() => true, () => false);
    if (exists) { flash('AGENTS.md already exists here · /init skipped so it is not overwritten'); void openFile(chat.folderId, 'AGENTS.md'); return; }
    await sendCommandPrompt(INIT_PROMPT, 'Creating AGENTS.md');
  };
  /** `/review` (Codex): a findings-only review of the folder's uncommitted changes. */
  const runReview = async () => {
    if (!chat.folderId) return;
    let files: string[];
    try { files = ((await invoke('git.status', { folderId: chat.folderId }))?.files ?? []).map(file => file.path); }
    catch (cause) { flash(`Cannot review: ${runtimeMessage(cause)}`); return; }
    if (!files.length) { flash('No uncommitted changes to review'); return; }
    await sendCommandPrompt(reviewPrompt(files), `Reviewing ${plural(files.length, 'changed file')}`);
  };
  /** ⌘⇧Enter (CS-B8-2, T3 thread.steerQueuedMessage): the head of the queue goes now — steered into the live turn, or started when idle. */
  const sendFirstQueued = async () => {
    const head = queue[0];
    if (!head) { flash('Nothing queued'); return; }
    try {
      const result = await invoke('chat.queue.steer', { id: chat.id, queueId: head.id });
      flash(result?.reason ?? (result?.steered ? 'Sent to the running agent' : result?.started ? 'Sent the first queued message' : 'The agent could not take it right now · still queued'));
    } catch (cause) { setQueueError(runtimeMessage(cause)); }
  };
  /** Next / Submit for the pending question; typed text is the custom answer and leaves the composer once used. */
  const answerQuestion = async () => {
    if (!questionFlow) return;
    const value = text, { usedTyped } = await questionFlow.advance(value);
    if (usedTyped) clearIfUnchanged(value);
    requestAnimationFrame(() => input.current?.focus());
  };
  const openTerminals = () => {
    if (runningTerminals.shells && terminalDock().placement === 'panel') { setTerminalDock({ open: true }); return; }
    setTerminalPaneView(chat.id, runningTerminals.shells ? 'terminals' : 'commands');
    openTab({ id: `processes:${chat.id}`, kind: 'processes', chatId: chat.id, title: `Terminal · ${chat.title || 'Chat'}` });
  };

  /* Popover rows -- shared with the new-chat draft via ComposerMenu.tsx's row builders, so the two
   * can never drift back out of parity. ----------------------------------------------------------- */
  // `/` lists skills and Muster's own commands only — plugins belong to `@` (mention) and the + menu,
  // not this trigger, which otherwise turns into a second dump of every installed plugin.
  const commandRows: MenuRow[] = !slash ? [] : COMPOSER_COMMANDS.flatMap(command => {
    const score = scoreItem(command.command, `${command.description} ${command.keywords}`, slash.query); if (score === null) return [];
    const Icon = COMMAND_ICONS[command.id];
    return [{ key: `command:${command.id}`, section: 'Commands', label: `/${command.command}`, mono: true, description: command.id === 'plan' ? (planMode ? 'Turn plan mode off' : 'Turn plan mode on') : command.description,
      icon: <span className={`composer-command-tile is-${command.id}`} style={typeof command.hue === 'number' ? { '--h': command.hue } as React.CSSProperties : undefined}><Icon size={12} /></span>,
      disabled: commandDisabled(command.id), score, run: () => runCommand(command.id, { start: slash.start, end: caret }) }];
  });
  const slashRows: MenuRow[] = !slash ? [] : buildSlashRows(slash.query, skills, skill => insertChip(skillChip(skill), { start: slash.start, end: caret }), commandRows);

  const mentionRange = mention ? { start: mention.start, end: caret } : undefined;
  const mentionRows: MenuRow[] = !mention ? [] : (() => {
    const q = mentionQuery;
    const chats = !q ? [] : (state.snapshot?.chats ?? []).flatMap(entry => { if (entry.id === chat.id || entry.archived) return []; const score = scoreQueryMatch(entry.title || '', q); if (score === null) return [];
      const title = entry.title || 'Untitled chat';
      return [{ key: `chat:${entry.id}`, section: 'Recent chats', label: title, icon: <MessagesSquare size={15} className="is-hued" style={{ '--h': 212 } as React.CSSProperties} />, score,
        run: () => insertChip({ token: chipToken('chat', title), kind: 'chat', id: entry.id, label: title }, mentionRange) } as MenuRow]; }).slice(0, MENU_LIMIT);
    // Codex's `@` trigger also reaches Sketch (aliases draw, drawing).
    const sketchScore = q ? scoreItem('sketch', 'draw drawing', q) : null;
    const tools: MenuRow[] = sketchScore === null || chat.archived ? [] : [{ key: 'tool:sketch', section: 'Tools', label: 'Sketch', description: 'Draw a sketch', icon: <PenLine size={15} />, score: sketchScore,
      run: () => { if (mentionRange) replaceRange(mentionRange.start, mentionRange.end, ''); openSketch(); } }];
    return buildMentionRows({
      query: q, files: mentionEntries.entries ?? [], plugins,
      onFile: entry => insertChip({ token: chipToken(entry.kind === 'directory' ? 'folder' : 'file', entry.path), kind: entry.kind === 'directory' ? 'folder' : 'file', id: entry.path, label: baseFileName(entry.path) }, mentionRange),
      onPlugin: plugin => invokePlugin(plugin, mentionRange),
      extra: [{ title: 'Recent chats', rows: chats }, { title: 'Tools', rows: tools }],
    });
  })();

  const plusRows: MenuRow[] = menu !== 'plus' ? [] : buildAddRows({
    query: plusQuery,
    onFiles: () => { setMenu(null); savedSelection.current = null; fileInput.current?.click(); },
    onCapture: () => void captureWindow(), captureDisabled: chat.archived,
    terminals, onAttachTerminal: source => void attachTerminal(source), terminalDisabled: chat.archived,
    onProject: () => { savedSelection.current = null; setMenu('project'); }, projectDisabled: chat.archived,
    goalDescription: chat.goal && chat.goal.status !== 'complete' && !text.trim() ? 'Edit the goal this chat pursues' : 'Set a goal to keep pursuing', goalDisabled: chat.archived, onGoal: () => openGoal(),
    planMode, planDisabled: choicesDisabled, onPlan: () => { setMenu(null); restoreCaret(); void togglePlan(); },
    onRecordSkill: () => void recordSkill(), recordDisabled: chat.archived,
    onSaveSkill: openSaveSkill, saveSkillDisabled: chat.archived,
    onSketch: () => openSketch(), sketchDisabled: chat.archived,
    onMention: () => { const range = currentRange(); setMenu(null); savedSelection.current = null; const lead = range.start > 0 && !/\s/.test(text[range.start - 1]) ? ' ' : ''; setDismissed(null); replaceRange(range.start, range.end, `${lead}@`); },
    backgroundDescription: hasPayload ? 'Send this as a new chat and stay here · ⌥Enter' : 'Write a message first · ⌥Enter', backgroundDisabled: !hasPayload || chat.archived || attachments.length > 0, onBackground: () => void startInBackground(),
    onStash: () => { setMenu(null); void promptStash.stash(); }, stashDisabled: chat.archived || !hasPayload, onStashes: () => { setMenu(null); promptStash.setOpen(true); },
    plugins, onPlugin: plugin => invokePlugin(plugin), onBrowsePlugins: () => { setMenu(null); openPluginsScreen('plugins'); },
    skills, onSkill: skill => insertChip(skillChip(skill)),
    connectors: connectorEntries(mcpServers, state.plugins.value ?? []), onConnector: connector => insertChip({ token: chipToken(connector.kind, connector.name), kind: connector.kind, id: connector.key, label: connector.name }),
    queueing: state.followUpMode === 'queue', onQueueing: running || queue.length ? () => {
      const next = state.followUpMode === 'queue' ? 'steer' : 'queue';
      setFollowUpMode(next); setMenu(null); restoreCaret();
      flash(next === 'queue' ? 'Queueing on · Enter queues follow-ups' : 'Queueing off · Enter steers the running agent');
    } : undefined,
  });

  const caretRows = slash ? slashRows : mention ? mentionRows : [];
  const caretActive = caretRows[popoverActive]?.disabled ? firstRow(caretRows) : Math.min(popoverActive, caretRows.length - 1);
  const plusIndex = plusRows[plusActive]?.disabled ? firstRow(plusRows) : Math.min(plusActive, plusRows.length - 1);

  const onPlusKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = nextRow(plusRows, plusIndex, event.key === 'ArrowDown' ? 1 : -1); if (next >= 0) setPlusActive(next); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setPlusActive(event.key === 'Home' ? firstRow(plusRows) : plusRows.length - 1); }
    else if (event.key === 'Enter') { event.preventDefault(); const row = plusRows[plusIndex]; if (row && !row.disabled) row.run(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); restoreCaret(); }
    else if (event.key === 'Backspace') { event.preventDefault(); setPlusQuery(value => value.slice(0, -1)); setPlusActive(0); }
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); setPlusQuery(value => value + event.key); setPlusActive(0); }
  };
  const navigateMenu = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setMenu(null); accessTrigger.current?.focus(); return; }
    const direction = ({ ArrowDown: 'next', ArrowUp: 'previous', Home: 'first', End: 'last' } as const)[event.key as 'ArrowDown'];
    if (!direction || event.metaKey || event.ctrlKey || event.altKey) return;
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if (!buttons.length) return;
    event.preventDefault(); const index = [...buttons].indexOf(document.activeElement as HTMLButtonElement);
    buttons[menuIndex(index, buttons.length, direction)]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const field = event.currentTarget, mod = event.metaKey || event.ctrlKey;
    // CS-B11-2: 1–9 pick while the custom answer is empty; Enter is Next/Submit (the popovers keep Enter while open).
    if (questionFlow && !questionFlow.collapsed && !mod && !event.altKey && !caretRows.length) {
      const digit = questionDigit(event.key);
      if (digit !== null && !text.trim() && digit < questionFlow.question.options.length) { event.preventDefault(); questionFlow.pick(digit); return; }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!event.repeat) void answerQuestion(); return; }
    }
    if (mod && event.shiftKey && !event.altKey && event.key === 'Enter') { event.preventDefault(); if (!event.repeat) void sendFirstQueued(); return; }
    if (mod && event.shiftKey && !event.altKey) {
      const lower = event.key.toLowerCase();
      if (lower === 'm') { event.preventDefault(); setMenu(null); setModelOpen(open => !open); return; }
      if (lower === 'e') { event.preventDefault(); const next = nextEffort(modelEfforts, effort); chooseEffort(next); flash(`Reasoning: ${EFFORT_LABELS[next]}`); return; }
      if (lower === 'a') { event.preventDefault(); if (!settingsBlocked) openAccess(); return; }
      if (lower === 's') { event.preventDefault(); void promptStash.stash(); return; }
    }
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'u') { event.preventDefault(); fileInput.current?.click(); return; }
    if (caretRows.length || slash || mention) {
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(text); return; }
      if (!mod && !event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && caretRows.length) { event.preventDefault(); const next = nextRow(caretRows, caretActive, event.key === 'ArrowDown' ? 1 : -1); if (next >= 0) setPopoverActive(next); return; }
      if (!mod && !event.altKey && !event.shiftKey && (event.key === 'Enter' || event.key === 'Tab') && caretRows[caretActive] && !caretRows[caretActive].disabled) { event.preventDefault(); if (!event.repeat) caretRows[caretActive].run(); return; }
    }
    // CS-B3-6: Tab takes the plugin's default prompt shown after its chip.
    if (event.key === 'Tab' && !event.shiftKey && !mod && !event.altKey && promptHint) { event.preventDefault(); replaceRange(text.length, text.length, `${/\s$/.test(text) ? '' : ' '}${promptHint}`); return; }
    if (event.key === 'Tab' && event.shiftKey && !mod && !event.altKey) { event.preventDefault(); void togglePlan(); return; }
    // Chips move and delete as one unit.
    if (!mod && !event.altKey && !event.shiftKey && field.selectionStart === field.selectionEnd && chipRanges.length) {
      const at = field.selectionStart;
      if (event.key === 'Backspace') { const range = chipRanges.find(entry => entry.end === at); if (range) { event.preventDefault(); field.setSelectionRange(range.start, range.end); setSelection({ start: range.start, end: range.end }); return; } }
      if (event.key === 'ArrowLeft') { const range = chipRanges.find(entry => at > entry.start && at <= entry.end); if (range) { event.preventDefault(); field.setSelectionRange(range.start, range.start); setCaret(range.start); setSelection({ start: range.start, end: range.start }); return; } }
      if (event.key === 'ArrowRight') { const range = chipRanges.find(entry => at >= entry.start && at < entry.end); if (range) { event.preventDefault(); field.setSelectionRange(range.end, range.end); setCaret(range.end); setSelection({ start: range.end, end: range.end }); return; } }
    }
    if (event.key === 'Escape' && running && !text && !mod) {
      event.preventDefault();
      const now = Date.now();
      if (now - escapeAt.current < 600) { escapeAt.current = 0; void stopChat(chat.id); } else { escapeAt.current = now; flash('Press Esc again to stop'); }
      return;
    }
    if (event.key === 'Enter' && event.altKey && !event.shiftKey && !mod) { event.preventDefault(); if (!event.repeat) void startInBackground(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      if (!mod && insideFence(text, field.selectionStart)) return;
      event.preventDefault();
      if (sending || event.repeat) return;
      // While the agent works, Enter follows the Follow-up behavior setting; Cmd/Ctrl+Enter does the opposite once.
      if (running) { void followUp(mod); return; }
      submit();
      return;
    }
    if (mod || event.altKey || event.shiftKey || field.selectionStart !== field.selectionEnd) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (attachments.length || questionFlow) return;
    const up = event.key === 'ArrowUp';
    const style = getComputedStyle(field);
    const oneLine = field.scrollHeight <= parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 1;
    if (text && !(oneLine || (up ? field.selectionStart === 0 : field.selectionEnd === text.length))) return;
    if (!recall.current) {
      if (!up || text !== '') return;
      const values = (state.timelines[chat.id]?.value ?? []).filter(item => item.kind === 'user').map(item => item.text).reverse();
      if (!values.length) return;
      recall.current = { values, index: -1 };
    }
    const history = recall.current;
    const index = Math.max(-1, Math.min(history.values.length - 1, history.index + (up ? 1 : -1)));
    event.preventDefault();
    history.index = index;
    replaceRange(0, text.length, index < 0 ? '' : history.values[index]);
    if (index < 0) recall.current = null;
  };
  const onFieldMouseMove = (event: React.MouseEvent) => {
    const layer = mirror.current, field = input.current?.parentElement;
    if (!layer || !field) { if (chipHover) setChipHover(null); return; }
    const box = field.getBoundingClientRect();
    const hit = [...layer.querySelectorAll<HTMLElement>('.token-chip')].find(node => { const rect = node.getBoundingClientRect(); return event.clientX >= rect.left - 2 && event.clientX <= rect.right + 14 && event.clientY >= rect.top - 2 && event.clientY <= rect.bottom + 2; });
    if (!hit) { if (chipHover) setChipHover(null); return; }
    const rect = hit.getBoundingClientRect(), index = Number(hit.dataset.index);
    if (chipHover?.index !== index) setChipHover({ index, left: rect.right - box.left - 6, top: rect.top - box.top - 5, start: rect.left - box.left });
  };

  const errorId = `composer-error-${chat.id}`;
  const descriptionIds = draft?.error || sendError || queueError ? errorId : undefined;
  const modelName = selectedModel?.name ?? humanizeModel(chat.model);
  const primaryDisabled = !hasPayload || staging || sending || modelChanging || settingsChanging || chat.archived || recoveryNeeded;
  const answering = Boolean(questionFlow && !questionFlow.collapsed);
  const placeholder = dictation ? (dictation.interim || 'Listening…') : chat.archived ? 'Restore this chat to continue' : answering ? (questionFlow!.question.options.length ? 'Type your own answer, or leave blank to use the selected option' : 'Type your answer') : !providers.length && state.providers.phase === 'ready' ? 'Enable a provider to send a message' : running ? 'Working…' : planMode ? 'Describe your task to generate a plan…' : 'Do anything';
  const caretPopoverId = slash ? 'composer-slash-options' : 'composer-mention-options';
  const providerGroups = modelTab === 'all' ? providers.map(provider => ({ provider, models: visibleModels.filter(model => model.providerId === provider.id) })).filter(group => group.models.length) : [{ provider: undefined, models: visibleModels }];
  const hovered = chipHover ? tokenRanges[chipHover.index] : undefined;

  const questionSlot = questionFlow ? <ComposerQuestionPanel key={`question:${questionFlow.item.id}`} flow={questionFlow} typed={text} onNext={() => void answerQuestion()} onFocusInput={() => requestAnimationFrame(() => input.current?.focus())} /> : null;
  const infoSlot = panel?.kind === 'info' ? <ComposerInfoCard key={`info:${chat.id}`} view={panel.view} chat={chat} modelName={modelName} accessLabel={accessOption.label} plugins={state.plugins.value ?? []}
    onClose={closeInfo} /> : null;
  const goalSlot = panel?.kind === 'goal'
    ? <GoalEditor key={`goal:${chat.id}`} chatId={chat.id} initial={panel.initial} mode={panel.mode} replaces={panel.mode === 'set' ? chat.goal : undefined} onDone={saved => goalDone(saved, panel.initial)} />
    : chat.goal ? <GoalStrip key={`goal:${chat.id}`} goal={chat.goal} onEdit={() => setPanel({ kind: 'goal', initial: chat.goal!.text, mode: 'edit' })} /> : null;
  /** Codex shows "Continuing goal…" on the submit button while an active goal is about to take its next turn. */
  const continuingGoal = chat.goal?.status === 'active' && !running && !sending && !hasPayload && !queue.length;
  const followUpVerb = followUpAction(state.followUpMode, false) === 'steer' ? 'Steer' : 'Queue', invertVerb = followUpVerb === 'Steer' ? 'Queue' : 'Steer';
  return <>{questionSlot ?? infoSlot ?? goalSlot}<div ref={composerRoot} data-testid="composer" className={`composer${dragging ? ' is-dragging' : ''}${chat.archived ? ' is-archived' : ''}`} aria-busy={sending}
    onDragEnter={event => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } }}
    onDragOver={event => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; if (!dragging) setDragging(true); } }}
    onDragLeave={event => { if (!composerRoot.current?.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { if (!hasFiles(event)) return; event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files ?? [])); input.current?.focus(); }}>
    <CheckoutQueueBanner chatId={chat.id} />
    <QueuedMessages chatId={chat.id} items={queue} paused={chat.queuePaused} running={running} skills={skills} plugins={state.plugins.value ?? []} onNote={flash} />
    {/* A sketch tile reopens its drawing (Codex openAttachment); other tiles keep AttachmentStrip's own open-in-right-pane. */}
    <div className="composer-attachments"><AttachmentStrip chatId={chat.id} items={attachments} onRemove={removeAttachment} onRetry={retryAttachment}
      onOpen={item => { if (!sketches.current.has(item.localId)) return false; openSketch(item.localId); return true; }} /></div>
    {imageBlind && attachments.some(item => item.kind === 'image') && <p className="composer-image-warning" role="status" data-testid="image-blind-warning">{imageBlindWarning(imageBlind)}</p>}
    {largePaste && <div className="composer-paste-offer" role="group" aria-label="Large paste">
      <FileText size={14} aria-hidden="true" /><span>Large paste · {formatBytes(largePaste.bytes)}</span>
      <button type="button" onClick={() => resolveLargePaste('attachment')}>Paste as attachment</button>
      <button type="button" onClick={() => resolveLargePaste('inline')}>Paste inline</button>
      <button type="button" aria-label="Discard paste" onClick={() => { setLargePaste(null); input.current?.focus(); }}><X size={12} /></button>
    </div>}
    <ContextStrip chips={shownContext} onRemove={id => { setContext(current => current.filter(chip => chip.id !== id)); requestAnimationFrame(() => input.current?.focus()); }} onOpenSource={openContextSource} />
    <div className={`composer-field${tokenRanges.length ? ' has-chips' : ''}`} onMouseMove={onFieldMouseMove} onMouseLeave={() => setChipHover(null)}>
      {tokenRanges.length > 0 && <ChipMirror text={text} ranges={tokenRanges} selected={selection} plugins={state.plugins.value ?? []} mirror={mirror} hint={promptHint || undefined} />}
      <textarea ref={input} data-testid="composer-input" className={`composer-input${answering && questionFlow!.question.isSecret ? ' is-secret' : ''}`} aria-label={answering ? 'Answer' : 'Message'} readOnly={chat.archived}
        aria-describedby={descriptionIds}
        aria-controls={slash || mention ? caretPopoverId : undefined} aria-expanded={slash || mention ? true : undefined}
        aria-activedescendant={caretRows.length && caretActive >= 0 ? `${caretPopoverId}-${caretActive}` : undefined}
        aria-keyshortcuts={modEnter ? 'Meta+Enter' : running ? 'Enter Meta+Enter' : 'Enter'}
        placeholder={placeholder} value={text} rows={1}
        onChange={event => { if (!programmatic.current) recall.current = null; setCaret(event.target.selectionStart); setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd }); setDismissed(null); setComposerDraft(chat.id, event.target.value); }}
        onSelect={event => { const { selectionStart: start, selectionEnd: end } = event.currentTarget; setCaret(start === end ? start : -1); setSelection({ start, end }); }}
        onScroll={event => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop; }}
        onBlur={() => { void flushComposerDraft(chat.id); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onPaste={onPaste} onKeyDown={onKeyDown} />
      {hovered && chipHover && <TokenCard range={hovered} plugins={state.plugins.value ?? []} skills={skills} left={Math.max(0, chipHover.start)} top={chipHover.top} />}
      {hovered && chipHover && <button type="button" className="token-chip-remove" aria-label={`Remove ${hovered.chip.label}`} style={{ left: chipHover.left, top: chipHover.top }}
        onMouseDown={event => event.preventDefault()} onClick={() => removeChip(hovered)}><X size={9} /></button>}
    </div>
    <input ref={fileInput} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; requestAnimationFrame(() => input.current?.focus()); }} />
    {dragging && <div className="composer-drop" aria-hidden="true"><Plus size={16} />Drop files to attach</div>}
    {(slash || mention) && <div data-testid="composer-popover" className={`composer-popover composer-caret-popover is-${slash ? 'slash' : 'mention'}`} data-browser-overlay style={popoverAnchor ? { left: popoverAnchor.left, bottom: popoverAnchor.bottom } : undefined}>
      <ComposerMenuList id={caretPopoverId} label={slash ? 'Skills and commands' : 'Mention'} rows={caretRows} active={caretActive} onActive={setPopoverActive}
        empty={slash ? (state.skills.phase === 'loading' ? 'Loading skills…' : 'No matching skill, command or plugin · @ for files')
          : mentionEntries.error ? mentionEntries.error : mentionEntries.loading ? 'Searching…' : 'No matching files, folders or plugins.'} />
      {mention && <p className="composer-command-hint">↑↓ to choose · Enter or Tab to insert · Esc to dismiss</p>}
    </div>}
    {menu === 'plus' && <div ref={plusMenu} data-testid="composer-popover" className="composer-popover composer-plus-popover" data-browser-overlay tabIndex={-1} role="dialog" aria-label="Add files and more"
      aria-activedescendant={plusIndex >= 0 && plusRows.length ? `composer-plus-options-${plusIndex}` : undefined} onKeyDown={onPlusKeyDown}>
      {plusQuery && <p className="composer-plus-filter"><Search size={12} aria-hidden="true" />{plusQuery}</p>}
      <ComposerMenuList id="composer-plus-options" label="Add" rows={plusRows} active={plusIndex} onActive={setPlusActive} empty="Nothing matches." />
    </div>}
    {promptStash.open && <StashesPopover onRestore={promptStash.restore} onClose={() => { promptStash.setOpen(false); restoreCaret(); }} />}
    {menu === 'project' && <ProjectPicker projects={projects} currentId={chat.projectId} moves={movesToProject} onChoose={next => void chooseProject(next)}
      onCreate={() => { setMenu(null); openProjectsScreen(); }} onClose={() => { setMenu(null); restoreCaret(); }} />}
    {menu === 'capture' && <CaptureSourcePicker sources={captureSources} onCapture={chooseCapture} onClose={() => { setMenu(null); restoreCaret(); }} />}
    {modelOpen && <div ref={modelPopover} data-testid="composer-popover" className="composer-popover composer-model-popover" data-browser-overlay aria-label="Select model" role="dialog">
      <div className="composer-model-rail" role="tablist" aria-label="Providers">
        {modelFavorites.length > 0 && <button type="button" role="tab" aria-selected={modelTab === 'favorites'} aria-label="Favorites" title="Favorites" onClick={() => setModelTab('favorites')}><Star size={14} /></button>}
        <button type="button" role="tab" aria-selected={modelTab === 'all'} aria-label="All providers" title="All providers" onClick={() => setModelTab('all')}><Cpu size={14} /></button>
        {providers.map(provider => <button key={provider.id} type="button" role="tab" aria-selected={modelTab === provider.id} aria-label={provider.name} title={provider.name} onClick={() => setModelTab(provider.id)}>
          <ProviderLogo id={provider.id} name={provider.name} endpoint={provider.endpoint} size={18} /></button>)}
      </div>
      <div className="composer-model-pane">
        <label className="composer-model-search"><Search size={13} /><input autoFocus type="search" aria-label="Search models" placeholder="Search models…" value={modelQuery} onChange={event => setModelQuery(event.target.value)} onKeyDown={onModelKeyDown} /></label>
        <div className="composer-model-list" role="listbox" aria-label="Available models" onKeyDown={onModelKeyDown}>
          {state.providers.phase === 'error' ? <p className="composer-model-note composer-model-error">{state.providers.error ?? 'Models could not be loaded.'}</p>
            : state.providers.phase === 'loading' && !modelOptions.length ? <p className="composer-model-note" role="status">Loading models…</p>
              : !modelOptions.length ? <p className="composer-model-note">No runnable models reported.</p>
                : !visibleModels.length ? <p className="composer-model-note">No models match this search.</p>
                  : providerGroups.map(group => <React.Fragment key={group.provider?.id ?? 'list'}>
                    {group.provider && <div className="composer-menu-section" role="presentation">{group.provider.name}</div>}
                    {group.models.map(model => { const key = favoriteKey(model), favorite = modelFavorites.includes(key), selected = model.id === chat.model && model.providerId === (chat.providerId ?? 'hybrow');
                      return <div className="composer-model-row" key={key}>
                        <button type="button" role="option" aria-selected={selected} disabled={modelChanging || settingsBlocked || (running && model.providerId !== currentProvider)} title={running && model.providerId !== currentProvider ? `Switch to ${model.provider} after this run` : `${model.provider} · ${model.id}`} onClick={() => void chooseModel(model.id, model.providerId)}>
                          <span className="composer-row-label">{model.name}</span>{modelTab !== 'all' && <span className="composer-row-description">{model.provider}</span>}{selected && <Check size={13} aria-hidden="true" />}
                          <span className="composer-model-badges">{modelBadges(model).map(badge => <span key={badge.id} className={`composer-model-badge${badge.known ? '' : ' is-unknown'}${badge.supported === false ? ' is-unsupported' : ''}`} title={badge.title}>{badge.label}</span>)}</span></button>
                        <button type="button" className="composer-model-favorite" aria-label={`${favorite ? 'Remove' : 'Add'} ${model.name} ${model.provider} ${favorite ? 'from' : 'to'} favorites`} aria-pressed={favorite} title={favorite ? 'Remove favorite' : 'Add favorite'} onClick={() => toggleModelFavorite(key)}><Star size={12} fill={favorite ? 'currentColor' : 'none'} /></button>
                      </div>; })}
                  </React.Fragment>)}
        </div>
        {hiddenModels.length > 0 && <p className="composer-model-note composer-model-hidden">{hiddenModels.length} hidden by your model settings · <button type="button" onClick={() => { setModelOpen(false); openAppSettings('models'); }}>Manage</button></p>}
        {running && <p className="composer-model-note">Applies to the next turn · other providers after this run</p>}
        {modelEfforts.length > 0 && <div className="composer-effort">
          <span className="composer-effort-title">Reasoning</span>
          <div className="composer-effort-segments" role="radiogroup" aria-label="Reasoning effort">
            {modelEfforts.map(value => <button key={value} type="button" role="radio" aria-checked={effort === value} onClick={() => chooseEffort(value)}>{EFFORT_LABELS[value]}</button>)}
          </div>
        </div>}
      </div>
    </div>}
      {menu === 'access' && <div ref={accessMenu} data-testid="composer-popover" className="composer-popover composer-access-menu" role="menu" aria-label="Permissions" onKeyDown={navigateMenu}>
        {ACCESS.map(option => <button key={option.id} type="button" role="menuitemradio" className={`is-${option.id}`} aria-checked={selectedAccess === option.id} disabled={settingsBlocked} onClick={() => void chooseAccess(option.id)}>
          <option.Icon size={15} aria-hidden="true" /><span><strong>{option.label}</strong><small>{option.description}</small></span>{selectedAccess === option.id && <Check size={13} aria-hidden="true" />}</button>)}
        {running && <p className="composer-access-note">Applies to the next turn</p>}
      </div>}
    <div className="composer-options" role="toolbar" aria-label="Message options">
      <div className="composer-toolbar-left">
        <button ref={plusTrigger} data-testid="composer-plus" type="button" className="composer-plus" aria-label="Add files and more" aria-haspopup="menu" aria-expanded={menu === 'plus'} title="Add files and more" onClick={openPlus}><Plus size={16} /></button>
        <button ref={accessTrigger} data-testid="composer-access" type="button" className={`composer-access is-${shownAccess}${planMode ? ' is-muted' : ''}`} aria-label={`Access: ${accessOption.label}`} aria-haspopup="menu" aria-expanded={menu === 'access'} disabled={settingsBlocked}
            title={planMode ? 'Plan mode runs read-only' : running ? 'Change permissions · applies to the next turn' : 'Change permissions'} onClick={openAccess}><accessOption.Icon size={14} aria-hidden="true" /><span className="composer-access-label">{accessOption.label}</span></button>
        {project && <button type="button" data-testid="composer-project" className="composer-project" aria-label={`Project: ${project.name}`} aria-haspopup="dialog" aria-expanded={menu === 'project'} title={project.goal ? `${project.name} · ${project.goal}` : project.name}
          onClick={() => { setModelOpen(false); setMenu(menu === 'project' ? null : 'project'); }}><FolderKanban size={13} aria-hidden="true" /><span>{project.name}</span></button>}
        {runningTerminals.shells + runningTerminals.commands > 0 && <button type="button" data-testid="composer-terminals" className="composer-terminals" title="Show running terminals" onClick={openTerminals}>
          <SquareTerminal size={13} aria-hidden="true" /><span>{terminalsPillLabel(runningTerminals.shells + runningTerminals.commands)}</span></button>}
        {planMode && <span className="composer-plan-chip"><Lightbulb size={13} aria-hidden="true" /><span>Plan</span><button type="button" aria-label="Turn plan mode off" disabled={choicesDisabled} onClick={() => void togglePlan()}><X size={11} /></button></span>}
        {/* MEM-X2: what the next turn will recall; click to inspect or leave notes out. */}
        <MemoryRecallChip chatId={chat.id} text={text} />
      </div>
      <div className="composer-toolbar-right">
        {running && <LoaderCircle size={14} className="composer-run-spinner composer-spin" aria-label="Working" />}
        <div className="composer-model-picker">
          <ProviderUsageHover providerId={chat.providerId ?? 'hybrow'}>
          <button ref={modelTrigger} data-testid="composer-model" type="button" className="composer-model-button" aria-label={`Model: ${modelName}`} aria-haspopup="dialog" aria-expanded={modelOpen} disabled={state.providers.phase === 'loading' && !modelOptions.length}
            title="Select model" onClick={() => { setMenu(null); setModelError(''); setModelOpen(value => !value); }}>
            <span className="composer-model">{modelName}</span>{modelEfforts.length > 0 && <span className="composer-effort-label">{EFFORT_LABELS[effort]}</span>}<ChevronDown size={12} aria-hidden="true" />
          </button>
          </ProviderUsageHover>
          {modelError && <span className="composer-model-error" role="alert">{modelError}</span>}
        </div>
        {Speech && <button type="button" data-testid="composer-mic" className={`composer-mic${dictation ? ' is-listening' : ''}`} aria-label={dictation ? 'Stop dictation' : 'Dictate'} aria-pressed={Boolean(dictation)} title={dictation ? 'Stop dictation' : 'Dictate'} disabled={chat.archived} onClick={toggleDictation}><Mic size={15} /></button>}
        {running && hasPayload && <button type="button" className="composer-stop is-ghost" aria-label="Stop" title="Stop" disabled={stopping} onClick={() => void stopChat(chat.id)}><Square size={11} fill="currentColor" /></button>}
        {running && hasPayload
          ? <button data-testid="composer-primary" type="button" className="composer-send" aria-label={`${followUpVerb} (Enter) · ${invertVerb} ⌘Enter`} title={`${followUpVerb} (Enter) · ${invertVerb} (⌘Enter)`} disabled={queueing || staging || chat.archived || recoveryNeeded} onClick={event => void followUp(event.metaKey || event.ctrlKey)}><ArrowUp size={15} strokeWidth={2.25} /></button>
          : running ? stopping
            ? <button data-testid="composer-primary" type="button" className="composer-stop is-stopping" aria-label={forceStop ? 'Force stop' : 'Stopping run'} disabled={!forceStop} title={forceStop ? 'The run has not stopped yet. Stop it again.' : 'Stopping…'} onClick={() => void stopChat(chat.id)}>
              <LoaderCircle size={26} className="composer-stop-ring composer-spin" aria-hidden="true" /><Square size={10} fill="currentColor" />{forceStop && <span>Force stop</span>}</button>
            : <button data-testid="composer-primary" type="button" className="composer-stop" aria-label="Stop" title="Stop" onClick={() => void stopChat(chat.id)}><Square size={11} fill="currentColor" /></button>
            : continuingGoal ? <button data-testid="composer-primary" type="button" className="composer-send is-continuing" aria-label="Continuing goal…" title="Continuing goal…" disabled><LoaderCircle size={15} className="composer-spin" /></button>
            : <button data-testid="composer-primary" type="button" className="composer-send" aria-label={sending ? 'Sending' : modEnter ? 'Send (⌘Enter)' : 'Send (Enter)'}
              title={recoveryNeeded ? 'Check the existing provider attempt before sending again' : chat.archived ? 'Restore this chat before sending' : sending ? 'Sending message…' : staging ? 'Waiting for attachments to upload' : sendError ? 'Retry message' : modEnter ? 'Send (⌘Enter) · New line (Enter) · New chat in background (⌥Enter)' : 'Send (Enter) · New line (Shift+Enter) · New chat in background (⌥Enter)'}
              disabled={primaryDisabled} onClick={() => submit()}>{sending ? <LoaderCircle size={15} className="composer-spin" /> : <ArrowUp size={15} strokeWidth={2.25} />}</button>}
      </div>
    </div>
    {settingsError && !fullConfirm && <div className="composer-error" role="alert">{settingsError}</div>}
    <FullAccessConfirm open={fullConfirm} folderName={state.snapshot?.folders.find(folder => folder.id === chat.folderId)?.name} canRemember={Boolean(chat.folderId)}
      pending={settingsChanging} blocked={settingsBlocked} error={settingsError || undefined} cancelRef={cancelFull} finalFocus={accessTrigger}
      onOpenChange={open => { if (!settingsPending.current) setFullConfirm(open); }} onConfirm={remember => void chooseAccess('full', true, remember)} />
    {sending ? <span className="composer-status" role="status" aria-live="polite">Sending…</span>
      : note ? <span className="composer-status" role="status" aria-live="polite">{note}</span>
      : dictation && text ? <span className="composer-status is-dictation" role="status" aria-live="polite">{dictation.interim ? `Listening… ${dictation.interim}` : 'Listening…'}</span> : null}
    {(draft?.error || sendError || queueError) && <div id={errorId} className="composer-error" role="alert">
      {draft?.error ? <>Draft not saved: {draft.error} <button type="button" onClick={() => void flushComposerDraft(chat.id)}>Retry save</button></>
        : queueError ? <>Could not queue: {queueError} Your draft is retained.</>
        : <>{sendError} Your draft is retained.</>}
    </div>}
    <RecordSkill open={panel?.kind === 'skill'} draft={panel?.kind === 'skill' ? panel.draft : { name: '', description: '', body: '' }} onClose={() => setPanel(null)} onSaved={skillSaved} />
    <SketchPad open={panel?.kind === 'sketch'} initial={panel?.kind === 'sketch' && panel.editing ? sketches.current.get(panel.editing) : undefined} onClose={() => { setPanel(null); requestAnimationFrame(() => input.current?.focus()); }}
      onAttach={(file, strokes) => attachSketch(file, strokes, panel?.kind === 'sketch' ? panel.editing : undefined)} />
    <ConfirmSheet open={confirmSend} testId="queue-send-confirm" title="Send message?" description={`You are about to send a message. Do you want to clear the ${plural(queue.length, 'message')} previously queued?`}
      onCancel={() => setConfirmSend(false)} actions={[{ label: 'Clear queue', run: () => void clearQueueAndSend() }, { label: 'Send message', primary: true, run: () => { setConfirmSend(false); submit(true); } }]} />
    {/* Composer stays mounted (just visually hidden) behind Memory/Settings/Projects/Automations, since only
        `.work-surface`'s `hidden` attribute changes when the screen does. Without the screen check this portal
        (ConfirmSheet renders via createPortal to document.body) would pop up over whichever unrelated screen
        the user navigated to while the send that triggers it was still in flight. */}
    <ConfirmSheet open={askResume && chat.goal?.status === 'paused' && state.screen === 'work'} testId="goal-resume" title="Resume paused goal?" description="Muster will keep working toward this goal when the chat is idle"
      onCancel={() => void answerResume('later')} actions={[{ label: 'Not now', run: () => void answerResume('later') }, { label: 'Keep paused', run: () => void answerResume('keep') }, { label: 'Resume goal', primary: true, run: () => void answerResume('resume') }]} />
  </div></>;
}
