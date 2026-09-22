import { ArrowUp, BookOpen, Bot, Check, ChevronDown, Cpu, FileText, FolderCheck, Globe, ListChecks, LockKeyhole, MessageCircle, Plus, Search, ShieldAlert, SlidersHorizontal, Slash, Square, Star, X } from 'lucide-react';
import { Dialog } from '@base-ui/react/dialog';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chat, Commands } from '../../shared/protocol';
import { invoke } from '../bridge';
import { flushComposerDraft, loadProviders, openBrowserTab, openPluginsScreen, openProvidersTab, sendMessage, setComposerDraft, stopChat, updateChat } from '../store';
import { useStore } from '../useStore';
import { COMPOSER_COMMANDS, configuredAccess, effectiveAccess, filterComposerCommands, insertWorkspaceReference, menuIndex, readSlashQuery, type ComposerAccess, type ComposerCommandId } from './composerMenus';
import './composer.css';

const COMMAND_ICONS = {reference:FileText,browser:Globe,skills:BookOpen,providers:SlidersHorizontal,model:Cpu,access:LockKeyhole,agent:Bot,ask:MessageCircle,plan:ListChecks};
const ACCESS = [{id:'read-only',label:'Read-only',description:'Read files without changing them',Icon:LockKeyhole},{id:'workspace',label:'Workspace',description:'Edit workspace files; ask before escalation',Icon:FolderCheck},{id:'full',label:'Full access',description:'Unrestricted filesystem, commands and network',Icon:ShieldAlert}] as const;
const MODEL_FAVORITES_KEY = 'muster.composer.model-favorites.v1';

function readModelFavorites(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(MODEL_FAVORITES_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

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

function humanizeModel(model: string): string {
  const value = model.trim().split('/').pop() ?? '';
  return value
    ? value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
    : 'Model unavailable';
}

export function Composer({ chat }: { chat: Chat }): React.ReactElement {
  const state = useStore();
  const draft = state.composerDrafts[chat.id];
  const text = draft?.text ?? chat.draft;
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const recall = useRef<{ values: string[]; index: number } | null>(null);
  const recoveryNeeded = chat.recovery?.kind === 'recovery-needed';
  const running = chat.status === 'running' || chat.status === 'stopping';
  const sending = Boolean(state.sending[chat.id]);
  const sendError = state.sendErrors[chat.id];
  const project = state.snapshot?.projects.find(project => project.id === chat.projectId);
  const folderIds = project?.folderIds ?? (chat.folderId ? [chat.folderId] : []);
  const referenceFolders = (state.snapshot?.folders ?? []).filter(folder => folderIds.includes(folder.id));
  const [referenceFolderId, setReferenceFolderId] = useState(chat.folderId ?? folderIds[0]);
  const folderId = referenceFolderId && referenceFolders.some(folder => folder.id === referenceFolderId) ? referenceFolderId : chat.folderId ?? folderIds[0];
  const composerRoot = useRef<HTMLDivElement>(null);
  const plusTrigger = useRef<HTMLButtonElement>(null);
  const accessTrigger = useRef<HTMLButtonElement>(null);
  const cancelFull = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<'plus'|'commands'|'mode'|'access'|null>(null);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandIndex, setCommandIndex] = useState(0);
  const [caret, setCaret] = useState(text.length);
  const [dismissedSlash, setDismissedSlash] = useState<string|null>(null);
  const [fullConfirm, setFullConfirm] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsChanging, setSettingsChanging] = useState(false);
  const settingsPending = useRef(false);
  const settingsRequest = useRef(0);
  const modelRequest = useRef(0);
  const currentDraft = useRef({chatId:chat.id,text});currentDraft.current={chatId:chat.id,text};
  const selectedAccess = configuredAccess(chat);
  const actualAccess = effectiveAccess(chat);
  const accessOption = ACCESS.find(option => option.id === actualAccess)!;
  const AccessIcon = accessOption.Icon;
  const ModeIcon = COMMAND_ICONS[chat.mode];
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [referenceResult, setReferenceResult] = useState<Commands['files.search']['output'] | null>(null);
  const [referenceError, setReferenceError] = useState('');
  const [referenceLoading, setReferenceLoading] = useState(false);
  const referenceRoot = useRef<HTMLDivElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [modelFavorites, setModelFavorites] = useState<string[]>(readModelFavorites);
  const [modelError, setModelError] = useState('');
  const [modelChanging, setModelChanging] = useState(false);
  const modelPending = useRef(false);
  const modelRoot = useRef<HTMLDivElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const modelOptions = (state.providers.value ?? []).filter(provider => provider.available).flatMap(provider => provider.models.map(model => ({ ...model, provider: provider.name, providerId: provider.id })));
  const visibleModels = modelOptions.filter(model => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(modelQuery.trim().toLowerCase()))
    .sort((a,b) => Number(modelFavorites.includes(`${b.providerId}:${b.id}`))-Number(modelFavorites.includes(`${a.providerId}:${a.id}`)) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  const selectedModel = modelOptions.find(model => model.id === chat.model && model.providerId === (chat.providerId ?? 'hybrow'));
  const slashQuery = readSlashQuery(text,caret);
  const typedCommands = !composing.current && slashQuery !== null && dismissedSlash !== text && menu === null && !referenceOpen && !modelOpen && !fullConfirm;
  const commandsOpen = menu === 'commands' || typedCommands;
  const commands = filterComposerCommands(typedCommands ? slashQuery ?? '' : commandQuery);
  const choicesDisabled = running || sending || settingsChanging || modelChanging || recoveryNeeded;
  const commandDisabled = (id:ComposerCommandId) => id==='reference'?!folderId:['agent','ask','plan','access','model'].includes(id)&&choicesDisabled;
  const enabledCommands=commands.flatMap((command,index)=>commandDisabled(command.id)?[]:[index]);
  const requestedCommand=Math.min(commandIndex,Math.max(0,commands.length-1));
  const selectedCommand=enabledCommands.includes(requestedCommand)?requestedCommand:enabledCommands[0]??0;

  useEffect(() => {setCommandIndex(0);}, [commandQuery,slashQuery]);
  useEffect(() => {
    setMenu(null);setReferenceOpen(false);setReferenceFolderId(chat.folderId ?? folderIds[0]);
    setFullConfirm(false);setSettingsError('');setDismissedSlash(null);setCaret(text.length);recall.current=null;setModelQuery('');
    settingsRequest.current++;modelRequest.current++;settingsPending.current=false;modelPending.current=false;setSettingsChanging(false);setModelChanging(false);
  }, [chat.id]);
  useEffect(() => {if(running || sending){setFullConfirm(false);setMenu(null);}},[running,sending]);
  useEffect(() => {
    if(!menu && !typedCommands)return;
    const dismiss=()=>{setMenu(null);setDismissedSlash(currentDraft.current.text);};
    const pointer=(event:PointerEvent)=>{if(!composerRoot.current?.contains(event.target as Node))dismiss();};
    const focus=(event:FocusEvent)=>{if(!composerRoot.current?.contains(event.target as Node) || (event.target===input.current && menu && menu!=='commands'))dismiss();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape' && !event.defaultPrevented){event.preventDefault();dismiss();input.current?.focus();}};
    document.addEventListener('pointerdown',pointer);document.addEventListener('keydown',key);document.addEventListener('focusin',focus);
    return()=>{document.removeEventListener('pointerdown',pointer);document.removeEventListener('keydown',key);document.removeEventListener('focusin',focus);};
  },[menu,typedCommands]);
  useEffect(()=>{
    if(!menu || menu==='commands')return;
    const frame=requestAnimationFrame(()=>composerRoot.current?.querySelector<HTMLButtonElement>('.composer-menu-popover button:not(:disabled)')?.focus());
    return()=>cancelAnimationFrame(frame);
  },[menu]);

  // Keep the observer stable for the lifetime of this composer. Text changes
  // resize through the separate layout effect below; recreating an observer
  // for every keystroke causes needless work and can flicker on narrow panes.
  useLayoutEffect(() => {
    const field = input.current;
    if (!field) return;
    let width = field.clientWidth;
    const resize = () => {
      if (field.clientWidth !== width) {
        width = field.clientWidth;
        resizeComposer(field);
      }
    };
    resizeComposer(field);
    const observer = new ResizeObserver(() => {
      resize();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [chat.id]);

  useLayoutEffect(() => {
    if (input.current) resizeComposer(input.current);
  }, [text]);

  useEffect(() => {
    const flush = () => { void flushComposerDraft(chat.id); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
      flush();
    };
  }, [chat.id]);

  useEffect(() => {
    if (!referenceOpen || !folderId || !referenceQuery.trim()) {
      setReferenceResult(null);
      setReferenceError('');
      setReferenceLoading(false);
      return;
    }
    let live = true;
    setReferenceResult(null);
    setReferenceError('');
    setReferenceLoading(true);
    const timer = window.setTimeout(() => {
      void invoke('files.search', { folderId, path: '', query: referenceQuery.trim() })
        .then(value => { if (live) { setReferenceResult(value); setReferenceLoading(false); } })
        .catch(cause => { if (live) { setReferenceLoading(false); setReferenceError(cause instanceof Error ? cause.message : String(cause)); } });
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
  }, [folderId, referenceOpen, referenceQuery]);

  useEffect(() => {
    if (state.providers.phase === 'idle') void loadProviders();
  }, [state.providers.phase]);

  useEffect(() => {
    if (!modelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (modelRoot.current && !modelRoot.current.contains(event.target as Node)) setModelOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setModelOpen(false); modelRoot.current?.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.focus(); }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (modelRoot.current && !modelRoot.current.contains(event.target as Node)) setModelOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); document.removeEventListener('focusin', onFocusIn); };
  }, [modelOpen]);

  useEffect(() => {
    setModelOpen(false);
    setModelError('');
  }, [chat.id, running, sending]);

  const chooseModel = async (model: string, providerId:string) => {
    if (choicesDisabled || modelPending.current || settingsPending.current) return;
    if (model === chat.model && providerId === (chat.providerId ?? 'hybrow')) { setModelOpen(false); modelTrigger.current?.focus(); return; }
    const request=++modelRequest.current;
    setModelError('');modelPending.current = true;setModelChanging(true);
    try {
      await invoke('chat.selectProvider',{id:chat.id,providerId,model});
      if(request===modelRequest.current && currentDraft.current.chatId===chat.id){setModelOpen(false);requestAnimationFrame(() => modelTrigger.current?.focus());}
    } catch(cause) {
      if(request===modelRequest.current && currentDraft.current.chatId===chat.id)setModelError(cause instanceof Error?cause.message:'Provider or model change was rejected. Your draft is unchanged.');
    } finally {if(request===modelRequest.current){modelPending.current = false;setModelChanging(false);}}
  };

  const toggleModelFavorite = (key: string) => {
    setModelFavorites(current => {
      const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key];
      try { window.localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(next)); } catch { /* Favorites remain usable for this session. */ }
      return next;
    });
  };

  const onModelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!modelOpen || !modelOptions.length) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const buttons = modelRoot.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (!buttons?.length) return;
    const current = document.activeElement instanceof HTMLButtonElement ? [...buttons].indexOf(document.activeElement) : -1;
    const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : (current <= 0 ? buttons.length - 1 : current - 1);
    buttons[next]?.focus();
  };

  useEffect(() => {
    if (!referenceOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (referenceRoot.current && !referenceRoot.current.contains(event.target as Node)) setReferenceOpen(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (referenceRoot.current && !referenceRoot.current.contains(event.target as Node)) setReferenceOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setReferenceOpen(false); input.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('focusin', onFocusIn); document.removeEventListener('keydown', onKeyDown); };
  }, [referenceOpen]);

  const submit = () => {
    if (!text.trim() || composing.current || sending || running || modelPending.current || settingsPending.current || chat.archived || recoveryNeeded) return;
    recall.current = null;
    void sendMessage(chat.id, text);
  };

  const addReference = (path: string) => {
    const field = input.current;
    const start = field?.selectionStart ?? text.length;
    const end = field?.selectionEnd ?? start;
    const selectedFolder = referenceFolders.find(folder => folder.id === folderId);
    const referencePath = folderId !== chat.folderId && selectedFolder ? `${selectedFolder.path.replace(/\/$/,'')}/${path}` : path;
    const next = insertWorkspaceReference(text,referencePath,start,end);
    const caret = next.caret;
    setComposerDraft(chat.id, next.text);
    setReferenceOpen(false);
    setReferenceQuery('');
    requestAnimationFrame(() => {
      if (input.current) { input.current.focus(); input.current.setSelectionRange(caret, caret); }
    });
  };

  const navigateReferences = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = referenceRoot.current?.querySelectorAll<HTMLButtonElement>('.composer-reference-results button');
    if (!buttons?.length) return;
    const current = document.activeElement instanceof HTMLButtonElement ? [...buttons].indexOf(document.activeElement) : -1;
    const next = event.key === 'ArrowDown'
      ? (current + 1) % buttons.length
      : (current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length);
    event.preventDefault();
    buttons[next].focus();
  };

  const showMenu = (next:'plus'|'commands'|'mode'|'access') => {
    setReferenceOpen(false);setModelOpen(false);setSettingsError('');
    setMenu(menu===next?null:next);setCommandQuery('');setCommandIndex(0);
  };
  const consumeCommand = (source:string|undefined) => {
    if(source !== undefined && currentDraft.current.chatId===chat.id && currentDraft.current.text===source){setComposerDraft(chat.id,'');setCaret(0);}
  };
  const chooseMode = async (mode:Chat['mode'],source?:string) => {
    if(choicesDisabled || settingsPending.current || modelPending.current)return;
    const request=++settingsRequest.current;
    settingsPending.current=true;setSettingsChanging(true);setSettingsError('');
    try {
      const accepted=await updateChat(chat.id,{mode});
      if(request!==settingsRequest.current || currentDraft.current.chatId!==chat.id)return;
      if(accepted){consumeCommand(source);setMenu(null);requestAnimationFrame(()=>input.current?.focus());}
      else setSettingsError('The mode could not be changed. Your draft is unchanged.');
    } finally {if(request===settingsRequest.current){settingsPending.current=false;setSettingsChanging(false);}}
  };
  const chooseAccess = async (permissionMode:ComposerAccess,acknowledgeFullAccess=false) => {
    if(choicesDisabled || settingsPending.current || modelPending.current)return;
    if(permissionMode===selectedAccess && !acknowledgeFullAccess){setMenu(null);accessTrigger.current?.focus();return;}
    if(permissionMode==='full' && !acknowledgeFullAccess){setMenu(null);setFullConfirm(true);return;}
    const request=++settingsRequest.current;
    settingsPending.current=true;setSettingsChanging(true);setSettingsError('');
    try {
      await invoke('chat.setPermissionMode',{id:chat.id,permissionMode,...(acknowledgeFullAccess?{acknowledgeFullAccess:true}:{})});
      if(request!==settingsRequest.current || currentDraft.current.chatId!==chat.id)return;
      setFullConfirm(false);setMenu(null);requestAnimationFrame(()=>accessTrigger.current?.focus());
    } catch(cause){if(request===settingsRequest.current && currentDraft.current.chatId===chat.id)setSettingsError(cause instanceof Error?cause.message:String(cause));}
    finally {if(request===settingsRequest.current){settingsPending.current=false;setSettingsChanging(false);}}
  };
  const runCommand = (id:ComposerCommandId) => {
    const source=typedCommands?text:undefined;
    if(id==='agent'||id==='ask'||id==='plan'){void chooseMode(id,source);return;}
    if((id==='access'||id==='model')&&choicesDisabled)return;
    if(id==='reference'&&!folderId)return;
    consumeCommand(source);setMenu(null);setDismissedSlash(text);setModelOpen(false);setReferenceOpen(false);
    if(id==='reference'){setReferenceQuery('');setReferenceOpen(true);}
    else if(id==='browser')openBrowserTab();
    else if(id==='skills')openPluginsScreen();
    else if(id==='providers')openProvidersTab();
    else if(id==='model')setModelOpen(true);
    else if(id==='access')setMenu('access');
  };

  const navigateMenu = (event:React.KeyboardEvent<HTMLElement>) => {
    const direction={ArrowDown:'next',ArrowUp:'previous',Home:'first',End:'last'}[event.key] as 'next'|'previous'|'first'|'last'|undefined;
    if(!direction || event.metaKey || event.ctrlKey || event.altKey)return;
    const buttons=event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if(!buttons.length)return;
    event.preventDefault();const index=[...buttons].indexOf(document.activeElement as HTMLButtonElement);
    buttons[menuIndex(index,buttons.length,direction)]?.focus();
  };
  const navigateCommands = (event:React.KeyboardEvent<HTMLElement>) => {
    if(event.nativeEvent.isComposing || composing.current || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)return false;
    if(event.key==='Escape'){event.preventDefault();setMenu(null);setDismissedSlash(text);input.current?.focus();return true;}
    if(!commands.length)return false;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();setCommandIndex(enabledCommands[menuIndex(enabledCommands.indexOf(selectedCommand),enabledCommands.length,event.key==='ArrowDown'?'next':'previous')]??0);return true;
    }
    if(event.key==='Enter'){
      event.preventDefault();if(!event.repeat && !commandDisabled(commands[selectedCommand].id))runCommand(commands[selectedCommand].id);return true;
    }
    return false;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const field = event.currentTarget;
    if(commandsOpen && navigateCommands(event))return;
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      // Keep Cmd/Ctrl+Enter as explicit idle-send; do not invent unsupported steering.
      if (running) return;
      if (!event.metaKey && !event.ctrlKey && insideFence(text, field.selectionStart)) return;
      event.preventDefault();
      if (sending || event.repeat) return;
      submit();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || field.selectionStart !== field.selectionEnd) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
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
    const value = index < 0 ? '' : history.values[index];
    setComposerDraft(chat.id, value);
    requestAnimationFrame(() => {
      if (input.current === field && document.activeElement === field && field.value === value) field.setSelectionRange(value.length, value.length);
    });
    if (index < 0) recall.current = null;
  };

  const errorId = `composer-error-${chat.id}`;
  const shortcutId = `composer-shortcuts-${chat.id}`;
  const descriptionIds = [shortcutId, draft?.error || sendError ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  const modelLabel = humanizeModel(chat.model);
  const sendLabel = sending ? 'Sending message' : sendError ? 'Retry message' : 'Send message (Enter)';

  return <div ref={composerRoot} className="composer" aria-busy={sending}>
    <textarea ref={input} className="composer-input" aria-label="Message"
      aria-describedby={descriptionIds}
      aria-controls={typedCommands?'composer-command-options':undefined} aria-expanded={typedCommands || undefined}
      aria-activedescendant={typedCommands && commands.length?`composer-command-${commands[selectedCommand].id}`:undefined}
      placeholder={running ? 'Agent is working…' : 'Send a follow-up…'} value={text} rows={1}
      onChange={event => { recall.current = null; setCaret(event.target.selectionStart); setDismissedSlash(null); setComposerDraft(chat.id, event.target.value); }}
      onSelect={event=>setCaret(event.currentTarget.selectionStart===event.currentTarget.selectionEnd?event.currentTarget.selectionStart:-1)}
      onBlur={() => { void flushComposerDraft(chat.id); }}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={onKeyDown} />
    {commandsOpen && <div className="composer-command-popover" data-browser-overlay>
      {menu==='commands' && <label className="composer-command-search"><Search size={13}/><input autoFocus type="search" aria-label="Search commands" placeholder="Search commands…" value={commandQuery} onChange={event=>setCommandQuery(event.target.value)} onKeyDown={navigateCommands} aria-controls="composer-command-options" aria-activedescendant={commands.length?`composer-command-${commands[selectedCommand].id}`:undefined}/></label>}
      <div id="composer-command-options" role="listbox" aria-label="Composer commands">{commands.map((command,index)=>{const Icon=COMMAND_ICONS[command.id];return <button id={`composer-command-${command.id}`} key={command.id} type="button" role="option" aria-selected={index===selectedCommand} disabled={commandDisabled(command.id)} onMouseDown={event=>event.preventDefault()} onMouseEnter={()=>setCommandIndex(index)} onClick={()=>runCommand(command.id)}><Icon size={15}/><span><strong>{command.label}</strong><small>{command.description}</small></span><kbd>/{command.command}</kbd></button>;})}</div>
      {!commands.length&&<p className="composer-menu-note">No matching commands.</p>}
      <p className="composer-command-hint">↑↓ to choose · Enter to run · Esc to dismiss</p>
    </div>}
    <div className="composer-options" role="toolbar" aria-label="Message options">
      <div className="composer-reference" ref={referenceRoot}>
        <button ref={plusTrigger} type="button" className="composer-option-icon" aria-label="Add context or open tools" aria-haspopup="menu" aria-expanded={menu==='plus'} title="Add context or open tools" onClick={()=>showMenu('plus')}><Plus size={16}/></button>
        {menu==='plus' && <div className="composer-menu-popover" role="menu" aria-label="Context and tools" onKeyDown={navigateMenu}>
          {(['reference','browser','skills','providers'] as const).map(id=>{const command=COMPOSER_COMMANDS.find(command=>command.id===id)!;const Icon=COMMAND_ICONS[id];return <button key={id} type="button" role="menuitem" disabled={commandDisabled(id)} title={id==='reference'&&!folderId?'Open a workspace folder to reference files':command.description} onClick={()=>runCommand(id)}><Icon size={15}/><span><strong>{command.label}</strong><small>{command.description}</small></span></button>;})}
          <button type="button" role="menuitem" onClick={()=>{setMenu('commands');setCommandQuery('');}}><Slash size={14}/><span><strong>Commands</strong><small>Find actions and chat modes</small></span><kbd>/</kbd></button>
        </div>}
        {referenceOpen && folderId && <div className="composer-reference-popover" role="dialog" aria-label="Reference a workspace file">
          {referenceFolders.length>1 && <label className="composer-reference-folder">Workspace<select aria-label="Reference workspace folder" value={folderId} onChange={event=>setReferenceFolderId(event.target.value)}>{referenceFolders.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
          <label className="composer-reference-search"><Search size={13} /><input autoFocus type="search" aria-label="Search workspace files" placeholder="Search workspace files…" value={referenceQuery} onChange={event => setReferenceQuery(event.target.value)} onKeyDown={navigateReferences} /><button type="button" aria-label="Close file reference picker" onClick={() => setReferenceOpen(false)}><X size={13} /></button></label>
          {!referenceQuery.trim() ? <p className="composer-reference-note">Search for a file in this chat’s workspace.</p>
            : referenceError ? <p className="composer-reference-error" role="alert">{referenceError}</p>
            : referenceLoading || !referenceResult ? <p className="composer-reference-note" role="status">Finding files…</p>
            : referenceResult.entries.length === 0 ? <p className="composer-reference-note">No matching files found.</p>
            : <ul className="composer-reference-results">{referenceResult.entries.map(entry => <li key={entry.path}><button type="button" title={entry.path} onKeyDown={navigateReferences} onClick={() => addReference(entry.path)}><FileText size={13} /><span>{entry.path}</span></button></li>)}</ul>}
        </div>}
      </div>
      <button type="button" className="composer-option-icon" aria-label="Open commands" aria-haspopup="listbox" aria-expanded={commandsOpen} title="Commands (/)" onClick={()=>showMenu('commands')}><Slash size={13}/></button>
      <div className="composer-picker-root">
        <button type="button" className="composer-choice" aria-label={`Chat mode: ${chat.mode}`} aria-haspopup="menu" aria-expanded={menu==='mode'} disabled={choicesDisabled} onClick={()=>showMenu('mode')}><ModeIcon size={13}/><span>{chat.mode==='agent'?'Agent':chat.mode==='ask'?'Ask':'Plan'}</span><ChevronDown size={11}/></button>
        {menu==='mode' && <div className="composer-menu-popover" role="menu" aria-label="Chat mode" onKeyDown={navigateMenu}>{(['agent','ask','plan'] as const).map(mode=>{const command=COMPOSER_COMMANDS.find(command=>command.id===mode)!;const Icon=COMMAND_ICONS[mode];return <button key={mode} type="button" role="menuitemradio" aria-checked={chat.mode===mode} disabled={choicesDisabled} onClick={()=>void chooseMode(mode)}><Icon size={15}/><span><strong>{command.label}</strong><small>{command.description}</small></span>{chat.mode===mode&&<Check size={13}/>}</button>;})}</div>}
      </div>
      <div className="composer-picker-root">
        <button ref={accessTrigger} type="button" className={`composer-choice composer-access is-${actualAccess}`} aria-label={`Agent access: ${accessOption.label}`} aria-haspopup="menu" aria-expanded={menu==='access'} disabled={choicesDisabled} title={chat.mode==='agent'?accessOption.description:`${chat.mode==='ask'?'Ask':'Plan'} uses read-only access. Configured Agent access: ${ACCESS.find(option=>option.id===selectedAccess)!.label}.`} onClick={()=>showMenu('access')}><AccessIcon size={13}/><span>{accessOption.label}</span><ChevronDown size={11}/></button>
        {menu==='access' && <div className="composer-menu-popover composer-access-menu" role="menu" aria-label="Agent access" onKeyDown={navigateMenu}>
          <p className="composer-menu-note">{chat.mode==='agent'?'Access applies to future Agent turns.':'Ask and Plan stay read-only. This selection applies when you use Agent.'}</p>
          {ACCESS.map(option=><button key={option.id} type="button" role="menuitemradio" aria-checked={selectedAccess===option.id} disabled={choicesDisabled} onClick={()=>void chooseAccess(option.id)}><option.Icon size={15}/><span><strong>{option.label}</strong><small>{option.description}</small></span>{selectedAccess===option.id&&<Check size={13}/>}</button>)}
        </div>}
      </div>
      <div className="composer-model-picker" ref={modelRoot}>
        <button ref={modelTrigger} type="button" className="composer-model-button" aria-label={`Model: ${selectedModel?.name ?? modelLabel}`} aria-haspopup="listbox" aria-expanded={modelOpen} disabled={choicesDisabled || state.providers.phase === 'loading'} title={selectedModel?`${selectedModel.provider} · ${selectedModel.id}`:chat.model || 'The active model was not reported'} onKeyDown={onModelKeyDown} onClick={() => { setMenu(null);setReferenceOpen(false);setModelError(''); setModelOpen(value => !value); }}>
          <Cpu size={12} className="composer-model-glyph" aria-hidden="true"/><span className="composer-model">{selectedModel?.name ?? modelLabel}</span><ChevronDown size={12} aria-hidden="true" />
        </button>
        {modelOpen && <div className="composer-model-popover" aria-label="Available models">
          <label className="composer-model-search"><Search size={13}/><input autoFocus type="search" aria-label="Search models" placeholder="Search models or providers…" value={modelQuery} onChange={event=>setModelQuery(event.target.value)} onKeyDown={onModelKeyDown} /></label>
          {state.providers.phase === 'error' ? <p className="composer-model-note composer-model-error">{state.providers.error ?? 'Models could not be loaded.'}</p>
            : state.providers.phase === 'loading' ? <p className="composer-model-note" role="status">Loading models…</p>
              : modelOptions.length === 0 ? <p className="composer-model-note">No runnable models reported.</p>
                : visibleModels.length === 0 ? <p className="composer-model-note">No models match this search.</p>
                : <div role="listbox" aria-label="Available models">{visibleModels.map(model => {const key=`${model.providerId}:${model.id}`;const selected=model.id===chat.model&&model.providerId===(chat.providerId??'hybrow');return <div className="composer-model-row" key={key}><button type="button" role="option" aria-selected={selected} disabled={modelChanging} title={`${model.provider} · ${model.id}`} onKeyDown={onModelKeyDown} onClick={() => void chooseModel(model.id,model.providerId)}><span><strong>{model.name}</strong><small>{model.provider}</small></span>{selected&&<Check size={13} aria-hidden="true" />}</button><button type="button" className="composer-model-favorite" aria-label={`${modelFavorites.includes(key)?'Remove':'Add'} ${model.name} ${model.provider} ${modelFavorites.includes(key)?'from':'to'} favorites`} aria-pressed={modelFavorites.includes(key)} title={modelFavorites.includes(key)?'Remove favorite':'Add favorite'} onClick={()=>toggleModelFavorite(key)}><Star size={13} fill={modelFavorites.includes(key)?'currentColor':'none'}/></button></div>;})}</div>}
        </div>}
        {modelError && <span className="composer-model-error" role="alert">{modelError}</span>}
      </div>
      <span id={shortcutId} className="composer-shortcuts">Enter to send · Shift+Enter for new line</span>
    </div>
    {running ? <button type="button" className="composer-stop" aria-label={chat.status === 'stopping' ? 'Stopping run' : 'Stop run'}
      disabled={chat.status === 'stopping'} onClick={() => void stopChat(chat.id)}><Square size={14} /></button>
      : <button type="button" className="composer-send" aria-label={sendLabel}
        title={recoveryNeeded ? 'Check the existing provider attempt before sending again' : chat.archived ? 'Restore this chat before sending' : sending ? 'Sending message…' : 'Enter to send · Shift+Enter for new line'}
        disabled={!text.trim() || sending || modelChanging || settingsChanging || chat.archived || recoveryNeeded} onClick={submit}><ArrowUp size={15} /></button>}
    {settingsError && !fullConfirm && <div className="composer-error" role="alert">{settingsError}</div>}
    <Dialog.Root open={fullConfirm} onOpenChange={open=>{if(!settingsPending.current)setFullConfirm(open);}}>
      <Dialog.Portal><Dialog.Backdrop className="composer-access-backdrop"/><Dialog.Popup className="composer-access-dialog" initialFocus={cancelFull} finalFocus={accessTrigger}>
        <Dialog.Title>Allow full access?</Dialog.Title>
        <Dialog.Description>Future Agent turns may read and change files anywhere your account can access, execute commands without approval, and use the network. Available actions still depend on the provider and its tools. Ask and Plan remain read-only.</Dialog.Description>
        {settingsError&&<p className="composer-reference-error" role="alert">{settingsError}</p>}
        <div><Dialog.Close ref={cancelFull} disabled={settingsChanging}>Cancel</Dialog.Close><button type="button" disabled={choicesDisabled} onClick={()=>void chooseAccess('full',true)}>{settingsChanging?'Applying…':'Allow full access'}</button></div>
      </Dialog.Popup></Dialog.Portal>
    </Dialog.Root>
    {sending && <span className="composer-status" role="status" aria-live="polite">Sending…</span>}
    {(draft?.error || sendError) && <div id={errorId} className="composer-error" role="alert">
      {draft?.error ? <>Draft not saved: {draft.error} <button type="button" onClick={() => void flushComposerDraft(chat.id)}>Retry save</button></>
        : <>Message not acknowledged. Your current draft is retained. {sendError}</>}
    </div>}
  </div>;
}
