import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, safeStorage, screen, session, shell, clipboard, systemPreferences } from 'electron';
import {execFile} from 'node:child_process';
import {BrowserSessionVault} from './browser-session-vault.ts';
import {PLUGIN_SCHEME,PluginUiRegistry} from './plugin-ui.ts';
import {applyThemeSource,themeFromSettingsResult,windowBackground} from './theme';
import path from 'node:path';
import { writeProjectExportFile, projectExportFilename } from './project-export-file.ts';
import {createRequire} from 'node:module';
import {ProcessSessions} from '../runtime/process-sessions.ts';
import {ScopedComputers} from '../runtime/scoped-computers.ts';
import {DesktopWorkspaces,commandAuthority,computerAuthority} from './desktop-workspaces.ts';
import { pathToFileURL } from 'node:url';
import { ARCHIVE_RUNNING_WARNING, type AgentEvent, type Commands, type Snapshot } from '../shared/protocol.ts';
import {chatMenuTemplate,folderMenuTemplate,projectMenuTemplate,popupChoice,type ChatMenuCommand,type FolderMenuCommand,type ProjectMenuCommand} from './chat-menu.ts';
import {attentionAllowed,createSettleTracker,notificationPrefs,notificationsMuted,wantedNotices,type NotificationPrefs} from './chat-notifications.ts';
import { isCommandName } from './commands.ts';
import { fileOperation, mutablePath } from '../runtime/file-operations.ts';
import { existsSync, promises as fs } from 'node:fs';
import { resolveInside } from '../runtime/paths.ts';
import {BrowserWorkspaceController} from './browser-workspace.ts';
import {BrowserBridge} from './agent-tools/browser-bridge.ts';
import {TERMINAL_MCP_LAUNCHER_ENV,TERMINAL_READ_MAX_BYTES,TerminalToolHost} from '../runtime/terminal-agent-tools.ts';
import {accessibilityText,captureSource,captureSources,computerPermissions} from './computer-capture.ts';
import {NativePreviewController} from './native-preview.ts';
import { buildMenuTemplate } from './menu.ts';
import { createQuitCoordinator, quitChoice, quitPrompt, withinDeadline } from './quit-coordinator.ts';
import { loadAgentService, type AgentService } from './service-loader.ts';
import { clampGeometry, DEFAULT_GEOMETRY, MIN_HEIGHT, MIN_WIDTH, planDisplayChange, WindowStateStore, type WindowGeometry } from './window-state.ts';
import {chatIdFromArgs,chatIdFromLink} from './chat-links.ts';
import {attentionBadge,createCrashTracker,isRendererCrash} from './app-shell.ts';
import {MENU_CHANNEL,MENU_CLOSE_CHANNEL,type MenuAction} from '../shared/menu-protocol.ts';
import {installProcessGuard} from './process-guard.ts';

app.setName('Muster Agent');
app.setPath('userData', app.commandLine.getSwitchValue('user-data-dir') || path.join(app.getPath('appData'), 'Muster Agent'));
// EXT-10: plugin UI gets its own standard origin (registered before ready), served only through PluginUiRegistry.
protocol.registerSchemesAsPrivileged([{scheme: PLUGIN_SCHEME, privileges: {standard: true, secure: true, supportFetchAPI: false, corsEnabled: true}}]);

// Single instance: second launch focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main().catch((error: unknown) => {
    console.error('Muster Agent startup failed:', error);
    dialog.showErrorBox('Muster Agent could not start', error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}

async function main(): Promise<void> {
  let window: BrowserWindow | null = null;
  // R3: a throw in a runtime timer or an unawaited promise must never take the app (and every running chat) down.
  installProcessGuard(process, {
    log: line => console.error(line),
    notify: message => { if (window && !window.isDestroyed() && !window.webContents.isLoading()) window.webContents.send('muster:event', {type: 'notice', message} satisfies AgentEvent); },
    onFatal: reason => {
      console.error(`[muster] shutting down after ${reason}`);
      try { dialog.showErrorBox('Muster Agent has to close', `Muster stopped after ${reason}. Your chats are saved; reopen the app to continue.`); } catch {}
      app.exit(1);
    },
  });
  let service: AgentService | null = null;
  let runningChats = 0;
  let disposal: Promise<void> | undefined;
  let shutdownStarted = false;
  let pendingChatId=chatIdFromArgs(process.argv);
  let openLinkedChat: (id:string)=>Promise<void> = async id=>{pendingChatId=id;};

  const stateStore = new WindowStateStore(app.getPath('userData'));

  app.on('second-instance', (_event,argv) => {
    const linked=chatIdFromArgs(argv);if(linked)void openLinkedChat(linked);
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  app.on('open-url',(event,url)=>{
    event.preventDefault();
    const linked=chatIdFromLink(url);if(linked)void openLinkedChat(linked);
  });

  app.on('activate', () => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  // Match the dark renderer with the dark native sidebar material until Settings > Appearance > Theme loads (UX-19).
  nativeTheme.themeSource = 'dark';
  await app.whenReady();
  app.setAsDefaultProtocolClient('muster');

  // --- Agent service -------------------------------------------------------
  const dataDir = path.join(app.getPath('userData'), 'agent-data');
  // Pending approvals/questions badge the dock while the window is not in front.
  let attentionCount = 0;
  let shownBadge = '';
  // AUT-05: monitoring notifications follow the user's settings (mute, failures only, attention alerts off).
  let notifyPrefs: NotificationPrefs = notificationPrefs(undefined);
  let pendingAttention = 0;
  const applyBadge = (requested: number): void => {
    pendingAttention = requested;
    const next = attentionAllowed(notifyPrefs, Date.now()) ? requested : 0;
    const focused = window !== null && !window.isDestroyed() && window.isVisible() && window.isFocused();
    const update = attentionBadge(attentionCount, next, focused);
    attentionCount = next;
    if (!update || (update.badge === shownBadge && !update.bounce)) return;
    shownBadge = update.badge;
    if (process.platform === 'darwin') {
      app.dock?.setBadge(update.badge);
      if (update.bounce) app.dock?.bounce('informational');
    } else {
      app.setBadgeCount(Number(update.badge) || 0);
      if (update.bounce && window && !window.isDestroyed()) window.flashFrame(true);
    }
  };
  // A run that finishes or fails out of sight gets one OS notification; clicking it opens that chat.
  const settled = createSettleTracker();
  const shownNotifications = new Set<Notification>();
  const notifySettled = (snapshot: Snapshot): void => {
    const focused = window !== null && !window.isDestroyed() && window.isVisible() && window.isFocused();
    lastActiveChatId = snapshot.activeChatId;
    // A run that just woke its chat from snooze already carried its one notification (chatWoke).
    const notices = wantedNotices(settled(snapshot, focused), notifyPrefs, Date.now()).filter(notice => !justWoke.has(notice.chatId));
    justWoke.clear();
    if (!notices.length || !Notification.isSupported()) return;
    for (const notice of notices.slice(0, 3)) {
      const toast = new Notification({ title: notice.title, body: notice.body });
      shownNotifications.add(toast);
      // macOS may never report close for an ignored toast; keep only the newest few alive for their click handlers.
      if (shownNotifications.size > 12) shownNotifications.delete(shownNotifications.values().next().value!);
      toast.on('click', () => { shownNotifications.delete(toast); void openLinkedChat(notice.chatId); });
      toast.on('close', () => shownNotifications.delete(toast));
      toast.show();
    }
  };
  // CHAT-15: a timed or activity wake carries exactly one notification (the runtime emits chatWoke once per transition).
  let lastActiveChatId: string | undefined;
  const justWoke = new Set<string>();
  const notifyWoke = (event: Extract<AgentEvent, {type:'chatWoke'}>): void => {
    if (event.reason === 'manual') return;
    justWoke.add(event.chatId);
    const onScreen = window !== null && !window.isDestroyed() && window.isVisible() && window.isFocused() && lastActiveChatId === event.chatId;
    if (onScreen || notificationsMuted(notifyPrefs, Date.now()) || !Notification.isSupported()) return;
    const toast = new Notification({ title: event.title, body: event.reason === 'time' ? 'Snooze ended' : 'Woke up: new activity' });
    shownNotifications.add(toast);
    if (shownNotifications.size > 12) shownNotifications.delete(shownNotifications.values().next().value!);
    toast.on('click', () => { shownNotifications.delete(toast); void openLinkedChat(event.chatId); });
    toast.on('close', () => shownNotifications.delete(toast));
    toast.show();
  };
  // R3: event delivery runs inside runtime domain code (emit); a delivery fault is logged, never thrown back into it.
  const onEvent = (event: AgentEvent): void => { try { deliverEvent(event); } catch (error) { console.error(`[muster] event delivery failed (${event.type}):`, error instanceof Error ? error.message : String(error)); } };
  const deliverEvent = (event: AgentEvent): void => {
    if (event.type === 'settingsChanged') { notifyPrefs = notificationPrefs(event.values); applyBadge(pendingAttention); }
    if (event.type === 'chatWoke') notifyWoke(event);
    if (event.type === 'snapshot') {
      runningChats = event.snapshot.chats.filter((c) => c.status === 'running' || c.status === 'stopping').length;
      applyBadge(event.snapshot.attention?.totalRequests ?? 0);
      notifySettled(event.snapshot);
    }
    if (window && !window.isDestroyed() && window.isVisible()) {
      window.webContents.send('muster:event', event);
    }
  };
  let userProcessGroups: () => ReturnType<ProcessSessions['userProcessGroups']> = () => [];
  const loaded = loadAgentService({ dataDir, onEvent, userProcesses: () => userProcessGroups() });
  service = loaded.service;
  void service.invoke('settings.get', {}).then(result => { notifyPrefs = notificationPrefs(result.values); applyBadge(pendingAttention); }, () => {});
  openLinkedChat=async id=>{
    if(!service||!window||window.isDestroyed()||window.webContents.isLoading()) { pendingChatId=id; return; }
    const snapshot=await service.invoke('app.snapshot',undefined);
    if(!snapshot.chats.some(chat=>chat.id===id)) {
      onEvent({type:'notice',message:'This local chat link is not available in this Muster profile.'});
      pendingChatId=null;return;
    }
    const items=await service.invoke('chat.select',{id});
    onEvent({type:'snapshot',snapshot:{...snapshot,activeChatId:id}});
    onEvent({type:'chatSelected',chatId:id});
    onEvent({type:'timeline',chatId:id,items});
    pendingChatId=null;
    if(window.isMinimized())window.restore();window.show();window.focus();
  };
  // CR-18: new terminals launch the Integrated terminal shell chosen in Preferences (login shell when unset or missing).
  const processes = new ProcessSessions(path.join(dataDir,'process-sessions.json'),async input=>commandAuthority(await loaded.service.invoke('app.snapshot',undefined),dataDir,input),onEvent,undefined,
    {terminal:{shell:async()=>(await loaded.service.invoke('settings.get',{})).values['terminal.shell']}});
  // C3.b4: read_thread_terminal for chats whose user allowed it; consent is re-checked on every call.
  const terminalTools = new TerminalToolHost({dir:path.join(dataDir,'agent-tools','terminal'),execPath:process.execPath,
    allowed:async chatId=>(await loaded.service.invoke('terminalAccess.get',{chatId})).allowed,
    tails:chatId=>processes.terminals.agentTails(chatId,TERMINAL_READ_MAX_BYTES*2)});
  void terminalTools.start().then(launcher=>{process.env[TERMINAL_MCP_LAUNCHER_ENV]=launcher;},error=>console.warn(`Agent terminal tool unavailable: ${error instanceof Error?error.message:String(error)}`));
  userProcessGroups = () => processes.userProcessGroups();
  const computers = new ScopedComputers({
    appData:dataDir,
    resolveScope:async scope=>computerAuthority(await loaded.service.invoke('app.snapshot',undefined),scope),
    loadCore:async()=>createRequire(__filename)(path.join(__dirname,'../runtime/scoped-computer-core.cjs')),
    onEvent:(event)=>onEvent(event as AgentEvent),
    pickImportPaths:async()=>{
      if(!window||window.isDestroyed())return null;
      const r=await dialog.showOpenDialog(window,{title:'Import into sandbox',properties:['openFile','openDirectory','multiSelections']});
      return r.canceled?null:r.filePaths;
    },
    pickExportPath:async(name)=>{
      if(!window||window.isDestroyed())return null;
      const r=await dialog.showSaveDialog(window,{title:'Export from sandbox',defaultPath:path.join(app.getPath('downloads'),name)});
      return r.canceled||!r.filePath?null:r.filePath;
    },
    // SBX-16: whole-workspace archive (.tar.gz + manifest), destination chosen here, never by the renderer.
    pickArchivePath:async(name)=>{
      if(!window||window.isDestroyed())return null;
      const r=await dialog.showSaveDialog(window,{title:'Export sandbox archive',defaultPath:path.join(app.getPath('downloads'),name),filters:[{name:'Archive',extensions:['tar.gz','tgz']}]});
      return r.canceled||!r.filePath?null:r.filePath;
    },
    // SBX-16: trusted layer sources, snapshotted by content version and mounted read-only at /opt/muster/<id>.
    layerSources:async()=>[
      {id:'skills',label:'Skills (~/.agents/skills)',path:path.join(app.getPath('home'),'.agents','skills')},
      {id:'tools',label:'Sandbox tools',path:path.join(dataDir,'sandbox-tools')},
    ],
  });
  const desktopWork = new DesktopWorkspaces(loaded.service,processes,computers);
  const syncNativeTheme=(theme:ReturnType<typeof themeFromSettingsResult>):void=>{
    if(!applyThemeSource(nativeTheme,theme))return;
    if(process.platform!=='darwin'&&window&&!window.isDestroyed())window.setBackgroundColor(windowBackground(nativeTheme.shouldUseDarkColors));
  };
  void loaded.service.invoke('settings.get',{}).then(result=>syncNativeTheme(themeFromSettingsResult(result)),()=>{});

  // --- Window --------------------------------------------------------------
  const saved = await stateStore.load();
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  const geometry = clampGeometry(saved ?? DEFAULT_GEOMETRY, displays);

  const isMac = process.platform === 'darwin';
  // The window is always created with vibrancy on macOS so its web contents are
  // transparent; Reduce Transparency then swaps the material for a solid
  // colour, and can be toggled at runtime without relaunching.
  const wantsVibrancy = isMac;

  window = new BrowserWindow({
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: 'Muster Agent',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    ...(wantsVibrancy
      ? { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const, transparent: false }
      : { backgroundColor: '#181818' }),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.cjs'),
      // The engine stays on; the 'Check spelling' setting toggles it via <html spellcheck> in the renderer.
      spellcheck: true,
      // A visible Agent window must paint streaming text and resize changes
      // even while another app has keyboard focus. Hidden windows are throttled below.
      backgroundThrottling: false,
    },
  });
  const nativePreview = new NativePreviewController(window);
  // BRW-06: tab history (auth-bearing URLs, page state) survives restarts only as safeStorage ciphertext.
  const browserWorkspace = new BrowserWorkspaceController(window, onEvent, undefined, {vault: new BrowserSessionVault(path.join(app.getPath('userData'), 'browser-sessions.json'), () => safeStorage)});
  window.on('close', () => browserWorkspace.persistSessions());
  const pluginUi = new PluginUiRegistry();
  if (!protocol.isProtocolHandled(PLUGIN_SCHEME)) protocol.handle(PLUGIN_SCHEME, async request => {
    const response = await pluginUi.respond(request.url);
    return new Response(typeof response.body === 'string' ? response.body : new Uint8Array(response.body), {status: response.status, headers: response.headers});
  });
  // RUN-X1: the agent drives this same browser through the muster_browser MCP bridge; each chat's tab shows in the right pane.
  const browserBridge = new BrowserBridge({dir:path.join(dataDir,'agent-tools'),browser:browserWorkspace,execPath:process.execPath,script:path.join(__dirname,'browser-mcp.cjs'),
    snapshot:()=>loaded.service.invoke('app.snapshot',undefined),lease:async chatId=>(await loaded.service.invoke('computer.lease',{chatId})).owner,emit:onEvent});
  void browserBridge.start().then(launcher=>{process.env.MUSTER_BROWSER_MCP_LAUNCHER=launcher;},error=>console.warn(`Agent browser bridge unavailable: ${error instanceof Error?error.message:String(error)}`));
  window.on('hide',()=>nativePreview.hide());
  window.on('closed',()=>nativePreview.hide());
  window.webContents.on('did-start-loading',()=>{nativePreview.hide();processes.detachAll();});
  if (geometry.maximized) window.maximize();
  window.once('ready-to-show', () => window?.show());

  // --- Appearance: follow Reduce Transparency live -------------------------
  let reducedTransparency: boolean | null = null;
  const syncTransparency = (): void => {
    if (!isMac || !window || window.isDestroyed()) return;
    const reduce = nativeTheme.prefersReducedTransparency;
    if (reduce === reducedTransparency) return;
    // setBackgroundColor also paints the web contents, so the transparent base must come back before the material does.
    if (!reduce && reducedTransparency) window.setBackgroundColor('#00000000');
    reducedTransparency = reduce;
    window.setVibrancy(reduce ? null : 'sidebar');
    if (reduce) window.setBackgroundColor('#181818');
  };
  syncTransparency();
  nativeTheme.on('updated', syncTransparency);
  window.on('focus', () => { applyBadge(attentionCount); if (!isMac) window?.flashFrame(false); });

  // --- Renderer crash recovery ---------------------------------------------
  const crashes = createCrashTracker();
  let recoveringRenderer = false;
  let unresponsiveDialog: AbortController | null = null;
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!window || window.isDestroyed() || shutdownStarted) return;
    if (!isRendererCrash(details.reason)) return;
    if (recoveringRenderer) { recoveringRenderer = false; window.webContents.reload(); return; }
    if (crashes.record(Date.now()) === 'reload') {
      window.webContents.once('did-finish-load', () => send({ type: 'notice', message: 'The window was reloaded after it stopped unexpectedly. Running work continued in the background.' }));
      window.webContents.reload();
      return;
    }
    void dialog.showMessageBox(window, {
      type: 'error',
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'The Muster window stopped again.',
      detail: `The window crashed twice within a minute (${details.reason}). Agent runs and background commands keep going in the host process; reloading restores the interface.`,
    }).then(({ response }) => {
      if (!window || window.isDestroyed()) return;
      if (response === 0) window.webContents.reload();
      else app.quit();
    });
  });
  window.webContents.on('unresponsive', () => {
    if (!window || window.isDestroyed() || unresponsiveDialog || shutdownStarted) return;
    const pending = unresponsiveDialog = new AbortController();
    void dialog.showMessageBox(window, {
      signal: pending.signal,
      type: 'warning',
      buttons: ['Wait', 'Reload'],
      defaultId: 0,
      cancelId: 0,
      message: 'The Muster window is not responding.',
      detail: 'Waiting keeps everything as it is. Reloading restarts only the interface; agent runs and background commands are not interrupted.',
    }).then(({ response }) => {
      if (unresponsiveDialog === pending) unresponsiveDialog = null;
      if (pending.signal.aborted || !window || window.isDestroyed() || response !== 1) return;
      // A hung renderer cannot honour reload(); ending it is expected, not a crash to count.
      recoveringRenderer = true;
      window.webContents.forcefullyCrashRenderer();
    });
  });
  // The renderer recovered on its own: the question no longer applies.
  window.webContents.on('responsive', () => unresponsiveDialog?.abort());

  // --- Displays: keep the window reachable when a screen goes away ----------
  const followDisplays = (): void => {
    if (!window || window.isDestroyed() || window.isFullScreen()) return;
    const bounds = window.getBounds();
    const plan = planDisplayChange({ ...bounds, maximized: window.isMaximized() }, screen.getAllDisplays().map((d) => d.bounds));
    if (plan.kind === 'keep') return;
    window.setSize(plan.width, plan.height);
    if (plan.kind === 'center') window.center();
  };
  screen.on('display-removed', followDisplays);
  screen.on('display-metrics-changed', followDisplays);
  const syncPainting = () => {
    if (!window || window.isDestroyed()) return;
    window.webContents.setBackgroundThrottling(!window.isVisible() || window.isMinimized());
  };
  window.on('hide', syncPainting);
  window.on('minimize', syncPainting);
  window.on('restore', syncPainting);
  window.on('show', () => {
    syncPainting();
    if (!service) return;
    void service.invoke('app.snapshot', undefined).then(async (snapshot) => {
      onEvent({ type: 'snapshot', snapshot });
      if (snapshot.activeChatId) {
        const items = await service!.invoke('chat.select', { id: snapshot.activeChatId });
        onEvent({ type: 'timeline', chatId: snapshot.activeChatId, items });
      }
    }).catch((error: Error) => onEvent({ type: 'notice', message: error.message }));
  });

  // --- Navigation hardening: renderer is app-local only --------------------
  const rendererEntry = path.join(__dirname, '../renderer/index.html');
  const rendererURL = pathToFileURL(rendererEntry).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  // Subframes may only load a registered plugin UI origin (EXT-10); everything else, and every main-frame navigation, is refused.
  window.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame && (pluginUi.allows(event.url) || event.url === 'about:srcdoc')) return; event.preventDefault(); });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // --- IPC: single validated entry point -----------------------------------
  const isTrustedSender = (frame: Electron.WebFrameMain | null, senderId: number): boolean =>
    window !== null && !window.isDestroyed() &&
    senderId === window.webContents.id &&
    frame !== null && frame === window.webContents.mainFrame &&
    frame.url.split('#')[0] === rendererURL;

  ipcMain.handle('muster:invoke', async (event, command: unknown, input: unknown) => {
    if (!isTrustedSender(event.senderFrame, event.sender.id)) {
      throw new Error('Rejected IPC from untrusted sender.');
    }
    if(shutdownStarted)throw new Error('Muster is stopping and saving work.');
    if (!isCommandName(command)) {
      throw new Error('Unknown command.');
    }
    switch(command) {
      case 'chat.contextMenu': {
        const request=input as Commands['chat.contextMenu']['input'];
        if(!request||typeof request.id!=='string'||request.id.length>256||!Number.isFinite(request.x)||!Number.isFinite(request.y)||(request.surface!==undefined&&request.surface!=='sidebar'&&request.surface!=='header'))throw new Error('Invalid chat menu request.');
        if(!service||!window||window.isDestroyed())throw new Error('Agent service is unavailable.');
        const snapshot=await service.invoke('app.snapshot',undefined);
        const chat=snapshot.chats.find(item=>item.id===request.id);
        if(!chat)throw new Error('Chat no longer exists.');
        const scale=window.webContents.getZoomFactor()||1;
        const chatFolder=chat.folderId?snapshot.folders.find(item=>item.id===chat.folderId&&!item.missing):undefined;
        const openIn=chatFolder?await service.invoke('files.openFolderWith.apps',undefined).then(result=>result.apps,()=>[]):[];
        const command=await popupChoice<ChatMenuCommand>((pick,closed)=>Menu.buildFromTemplate(chatMenuTemplate({chat,folders:snapshot.folders,projects:snapshot.projects,surface:request.surface??'sidebar',openIn},pick))
          .popup({window:window!,x:Math.round(request.x/scale),y:Math.round(request.y/scale),callback:closed}));
        return command?runChatMenuCommand(chat.id,command):null;
      }
      case 'folder.contextMenu': {
        const request=input as Commands['folder.contextMenu']['input'];
        if(!request||typeof request.id!=='string'||request.id.length>256||!Number.isFinite(request.x)||!Number.isFinite(request.y)||(request.run!==undefined&&request.run!=='relink'))throw new Error('Invalid folder menu request.');
        if(!service||!window||window.isDestroyed())throw new Error('Agent service is unavailable.');
        const folders=(await service.invoke('app.snapshot',undefined)).folders,folder=folders.find(item=>item.id===request.id);
        if(!folder)throw new Error('Folder no longer exists.');
        if(request.run==='relink')return runFolderMenuCommand(folder.id,{kind:'relink'});
        const scale=window.webContents.getZoomFactor()||1;
        const command=await popupChoice<FolderMenuCommand>((pick,closed)=>Menu.buildFromTemplate(folderMenuTemplate(folder,pick,{first:folders[0]?.id===folder.id,last:folders[folders.length-1]?.id===folder.id}))
          .popup({window:window!,x:Math.round(request.x/scale),y:Math.round(request.y/scale),callback:closed}));
        return command?runFolderMenuCommand(folder.id,command):null;
      }
      case 'project.contextMenu': {
        const request=input as Commands['project.contextMenu']['input'];
        if(!request||typeof request.id!=='string'||request.id.length>256||!Number.isFinite(request.x)||!Number.isFinite(request.y))throw new Error('Invalid project menu request.');
        if(!service||!window||window.isDestroyed())throw new Error('Agent service is unavailable.');
        const project=(await service.invoke('app.snapshot',undefined)).projects.find(item=>item.id===request.id);
        if(!project)throw new Error('Project no longer exists.');
        const scale=window.webContents.getZoomFactor()||1;
        return popupChoice<ProjectMenuCommand>((pick,closed)=>Menu.buildFromTemplate(projectMenuTemplate(project,pick))
          .popup({window:window!,x:Math.round(request.x/scale),y:Math.round(request.y/scale),callback:closed}));
      }
      case 'chat.update': {
        // Archiving never stops work; say so before it happens, for every entry point (menu, shortcut, hover button).
        const request=input as Commands['chat.update']['input'];
        if(request?.archived===true&&request.acknowledgeRunning!==true&&service&&typeof request.id==='string'&&!(await confirmArchive(request.id))){
          const snapshot=await service.invoke('app.snapshot',undefined);
          onEvent({type:'snapshot',snapshot});// undoes the renderer's optimistic archive
          const chat=snapshot.chats.find(item=>item.id===request.id);
          if(chat)return chat;
        }
        break;
      }
      case 'computer.permissions': return computerPermissions(systemPreferences);
      case 'computer.captureSources': return captureSources(desktopCapturer,window?.getMediaSourceId());
      case 'computer.captureSource': return captureSource(desktopCapturer,(input as Commands['computer.captureSource']['input'])?.id);
      case 'computer.accessibilityText': return accessibilityText((input as Commands['computer.accessibilityText']['input'])?.id,systemPreferences,(file,args)=>new Promise((resolve,reject)=>execFile(file,args,{timeout:8000,maxBuffer:1024*1024},(error,stdout,stderr)=>error?reject(new Error(String(stderr||error.message))):resolve(String(stdout)))));
      case 'plugins.ui.open': {
        if(!service)throw new Error('Agent service is unavailable.');
        const request=input as Commands['plugins.ui.open']['input'];
        return pluginUi.register(await service.invoke('plugins.ui.entry',{pluginId:request?.pluginId,app:request?.app}));
      }
      case 'browser.open': return browserWorkspace.open(input as Commands['browser.open']['input']);
      case 'browser.navigate': return browserWorkspace.navigate(input as Commands['browser.navigate']['input']);
      case 'browser.position': return browserWorkspace.position(input as Commands['browser.position']['input'], () => nativePreview.hide());
      case 'browser.hide': return browserWorkspace.hide(input as Commands['browser.hide']['input']);
      case 'browser.close': return browserWorkspace.close((input as Commands['browser.close']['input'])?.owner);
      case 'browser.back': return browserWorkspace.back((input as Commands['browser.back']['input'])?.owner);
      case 'browser.forward': return browserWorkspace.forward((input as Commands['browser.forward']['input'])?.owner);
      case 'browser.reload': return browserWorkspace.reload((input as Commands['browser.reload']['input'])?.owner);
      case 'browser.stop': return browserWorkspace.stop((input as Commands['browser.stop']['input'])?.owner);
      case 'browser.status': return browserWorkspace.status((input as Commands['browser.status']['input'])?.owner);
      case 'browser.release': return browserWorkspace.release((input as Commands['browser.release']['input'])?.owner);
      case 'browser.openExternal': await shell.openExternal(browserWorkspace.externalURL((input as Commands['browser.openExternal']['input'])?.owner));return;
      case 'browser.console': return browserWorkspace.console(input as Commands['browser.console']['input']);
      case 'browser.setViewport': return browserWorkspace.setViewport(input as Commands['browser.setViewport']['input']);
      case 'browser.capture': return browserWorkspace.capture(input as Commands['browser.capture']['input']);
      case 'browser.pickElement': return browserWorkspace.pickElement((input as Commands['browser.pickElement']['input'])?.owner);
      case 'browser.cancelPick': return browserWorkspace.cancelPick((input as Commands['browser.cancelPick']['input'])?.owner);
      case 'browser.clearData': return browserWorkspace.clearData((input as Commands['browser.clearData']['input'])?.profileId);
      case 'browser.closePopup': return browserWorkspace.closePopup((input as Commands['browser.closePopup']['input'])?.owner);
      case 'browser.download': {
        const request=input as Commands['browser.download']['input'];
        if(request?.action==='reveal')shell.showItemInFolder(browserWorkspace.downloadPath(request.owner,request.id));
        return browserWorkspace.download(request);
      }
      case 'browser.profiles': {
        // Scoped profile ids name a folder or Project; label them with what the user calls it.
        const snapshot=service?await service.invoke('app.snapshot',undefined).catch(()=>undefined):undefined;
        return browserWorkspace.profiles().map(profile=>{
          const [, kind, id]=/^(folder|project)-(.+)$/.exec(profile.id)??[];
          const name=kind==='folder'?snapshot?.folders.find(item=>item.id===id)?.name:kind==='project'?snapshot?.projects.find(item=>item.id===id)?.name:undefined;
          return name?{...profile,label:name}:profile;
        });
      }
    }
    if(command==='files.nativeAvailable')return nativePreview.available();
    if(command==='files.nativeHide'){const owner=(input as {owner:string})?.owner;if(typeof owner!=='string')throw new Error('Invalid preview owner.');nativePreview.hide(owner);return;}
    if(command==='files.nativePosition'){const request=input as Commands['files.nativePosition']['input'];nativePreview.position(request?.owner,request?.bounds);return;}
    if(command==='files.nativeShow'){
      browserWorkspace.hideAll(true);
      const request=input as Commands['files.nativeShow']['input'];
      if(!request || typeof request.folderId!=='string')throw new Error('Invalid preview request.');
      return nativePreview.show(request,async()=>{
        if(!service)throw new Error('Agent service unavailable.');
        const snapshot=await service.invoke('app.snapshot',undefined);
        const folder=snapshot.folders.find(f=>f.id===request.folderId);
        if(!folder)throw new Error('Folder does not exist.');
        return folder.path;
      });
    }
    if(command==='files.saveCopy'){
      if(!service||!window||window.isDestroyed())throw new Error('Agent service is unavailable.');
      const request=input as Commands['files.saveCopy']['input'];
      if(!request||typeof request.folderId!=='string'||typeof request.path!=='string'||!request.path||request.path.length>4096)throw new Error('Invalid Save a copy request.');
      const folder=(await service.invoke('app.snapshot',undefined)).folders.find(item=>item.id===request.folderId);
      if(!folder||folder.missing)throw new Error('Folder does not exist.');
      const source=await resolveInside(folder.path,request.path);// symlink and .. escapes are refused before anything is read
      if(!(await fs.stat(source)).isFile())throw new Error('Only files can be saved as a copy.');
      const result=await dialog.showSaveDialog(window,{title:'Save a Copy',defaultPath:path.join(app.getPath('downloads'),path.basename(source))});
      if(result.canceled||!result.filePath)return {saved:false};
      await fs.copyFile(source,result.filePath);
      return {saved:true,fileName:path.basename(result.filePath)};
    }
    if(command==='chat.export.file'){
      if(!service||!window||window.isDestroyed())throw new Error('Agent service is unavailable.');
      const request=input as Commands['chat.export.file']['input'];
      if(!request||typeof request.id!=='string'||request.id.length>256)throw new Error('Invalid chat export request.');
      const data=await service.invoke('chat.export',{id:request.id,format:request.format,...(request.redact===false?{redact:false}:{})});
      const filter=request.format==='json'?{name:'JSON',extensions:['json']}:request.format==='html'?{name:'Web page',extensions:['html']}:{name:'Markdown',extensions:['md']};
      const result=await dialog.showSaveDialog(window,{title:'Export Conversation',defaultPath:path.join(app.getPath('documents'),data.fileName),filters:[filter]});
      if(result.canceled||!result.filePath)return {saved:false};
      await writeProjectExportFile(result.filePath,data.text);
      return {saved:true,fileName:path.basename(result.filePath)};
    }
    if(command==='project.export.file'){
      if(!service||!window||window.isDestroyed())throw new Error('Agent service is unavailable.');
      const projectId=(input as Commands['project.export.file']['input'])?.projectId;
      if(typeof projectId!=='string'||projectId.length>256)throw new Error('Invalid Project export request.');
      const data=await service.invoke('project.export',{projectId});
      const result=await dialog.showSaveDialog(window,{title:'Save Project export',defaultPath:path.join(app.getPath('documents'),projectExportFilename(data.project.name)),filters:[{name:'Muster Project export',extensions:['json']}]});
      if(result.canceled||!result.filePath)return {saved:false};
      await writeProjectExportFile(result.filePath,JSON.stringify(data,null,2)+'\n');
      return {saved:true,fileName:path.basename(result.filePath),truncated:data.chats.truncated||data.tasks.truncated||data.decisions.truncated||data.activity.truncated};
    }
    if(command === 'clipboard.write'){
      const text=(input as {text?:unknown})?.text;
      if(typeof text!=='string'||text.length>2097152)throw new Error('Copy exceeds the 2 MB limit.');
      clipboard.writeText(text);return;
    }
    if(command === 'link.open'){
      const raw=(input as {url?:unknown})?.url;
      if(typeof raw!=='string'||raw.length>8192)throw new Error('Invalid link.');
      const url=new URL(raw);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Unsupported link.');
      await shell.openExternal(url.href);return;
    }
    if (command === 'folder.pick') {
      return pickFolder();
    }
    if (command === 'git.clone.pickDestination') {
      if (!window) return null;
      const suggested = (input as {suggested?: unknown})?.suggested;
      const result = await dialog.showOpenDialog(window, {title: 'Choose where to clone', message: 'The repository gets its own folder inside the one you choose.', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Choose', ...(typeof suggested === 'string' && suggested ? {defaultPath: suggested} : {})});
      return result.canceled || result.filePaths.length === 0 ? null : {path: result.filePaths[0]};
    }
    if (!service) throw new Error('Agent service is unavailable.');
    if (command === 'files.trash' || command === 'files.reveal') {
      const request = input as {folderId?:unknown;path?:unknown};
      if (!request || typeof request.folderId !== 'string' || typeof request.path !== 'string') throw new Error('Invalid file action.');
      const snapshot = await service.invoke('app.snapshot', undefined);
      const folder = snapshot.folders.find(item => item.id === request.folderId);
      if (!folder) throw new Error('Folder does not exist.');
      const relative = request.path;
      await fileOperation(folder.path, async () => {
        const absolute = await mutablePath(folder.path, relative, true);
        if (command === 'files.reveal') shell.showItemInFolder(absolute);
        else await shell.trashItem(absolute);
      });
      if (command === 'files.trash') onEvent({type:'workspaceChanged',folderId:folder.id});
      return;
    }
    const result = await desktopWork.invoke(command, input as Commands[typeof command]['input']);
    // UX-19: every settings command answers with the full values; keep the native appearance in step.
    if (command.startsWith('settings.')) syncNativeTheme(themeFromSettingsResult(result));
    return result;
  });

  const notice=(message:string)=>onEvent({type:'notice',message});
  const busy=(snapshot:Snapshot,id:string)=>{const chat=snapshot.chats.find(item=>item.id===id);return !!chat&&(chat.status==='running'||chat.status==='stopping'||!!snapshot.attention?.chats.some(item=>item.chatId===id));};
  async function confirmArchive(id:string):Promise<boolean>{
    if(!service||!window||window.isDestroyed())return true;
    const snapshot=await service.invoke('app.snapshot',undefined),chat=snapshot.chats.find(item=>item.id===id);
    if(!chat||chat.archived||!busy(snapshot,id))return true;
    const {response}=await dialog.showMessageBox(window,{type:'warning',buttons:['Archive','Cancel'],defaultId:0,cancelId:1,message:`Archive “${chat.title}” while it works?`,detail:`${ARCHIVE_RUNNING_WARNING} Stop the run first if you want it to end.`});
    return response===0;
  }
  async function runChatMenuCommand(id:string,command:ChatMenuCommand):Promise<Commands['chat.contextMenu']['output']>{
    if(!service||!window||window.isDestroyed())return null;
    const snapshot=await service.invoke('app.snapshot',undefined),chat=snapshot.chats.find(item=>item.id===id);
    if(!chat)throw new Error('Chat no longer exists.');
    const folder=chat.folderId?snapshot.folders.find(item=>item.id===chat.folderId):undefined;
    switch(command.kind){
      case 'renderer':return command.action;
      // Pin and archive go through the renderer so they get the same Undo notice as everywhere else (main's chat.update still confirms a running archive).
      case 'pin':return 'pin';
      case 'unread':await service.invoke('chat.markUnread',{id,unread:command.unread});return null;
      case 'archive':return 'archive';
      case 'delete':{
        const running=busy(snapshot,id);
        const {response}=await dialog.showMessageBox(window,{type:'warning',buttons:['Delete','Cancel'],defaultId:1,cancelId:1,message:`Permanently delete “${chat.title}”?`,
          detail:`${running?'It is still working; deleting stops the run first. ':''}Its messages, queued follow-ups and attached files are removed from this Mac. Files in the folder are not touched. This cannot be undone.`});
        if(response!==0)return null;
        await service.invoke('chat.delete',{id,force:running});notice(`Deleted “${chat.title}”`);return null;
      }
      case 'project':await service.invoke('chat.update',{id,projectId:command.projectId});return null;
      case 'folder':await service.invoke('chat.update',{id,folderId:command.folderId});return null;
      case 'folder-pick':{const picked=await pickFolder();if(picked)await service.invoke('chat.update',{id,folderId:picked.id});return null;}
      case 'copy':{
        const text=command.what==='link'?`muster://chat/${encodeURIComponent(id)}`:command.what==='id'?id:command.what==='path'?folder?.path??'':(await service.invoke('chat.export',{id,format:'markdown'})).text;
        if(!text)return null;
        clipboard.writeText(text);
        notice(command.what==='link'?'Local chat link copied':command.what==='id'?'Chat ID copied':command.what==='path'?'Folder path copied':'Conversation copied as Markdown (secrets redacted)');return null;
      }
      case 'export':{
        const draft=await service.invoke('chat.export',{id,format:'markdown'});
        const result=await dialog.showSaveDialog(window,{title:'Export Conversation',defaultPath:path.join(app.getPath('documents'),draft.fileName),filters:[{name:'Markdown',extensions:['md']},{name:'Web page',extensions:['html']},{name:'JSON',extensions:['json']}]});
        if(result.canceled||!result.filePath)return null;
        const extension=path.extname(result.filePath).toLowerCase();
        const data=extension==='.json'?await service.invoke('chat.export',{id,format:'json'}):extension==='.html'||extension==='.htm'?await service.invoke('chat.export',{id,format:'html'}):draft;
        await writeProjectExportFile(result.filePath,data.text);
        notice(`Exported to ${path.basename(result.filePath)}${data.omitted.length?` · ${data.omitted.length} kind${data.omitted.length===1?'':'s'} of content left out (listed at the end)`:''}`);return null;
      }
      case 'pin-move':await service.invoke('chat.movePin',{id,direction:command.direction});return null;
      case 'snooze':await service.invoke('chat.snooze',{id,...(command.until?{until:command.until}:{}),...(command.untilActivity?{untilActivity:true}:{})});return null;
      case 'wake':await service.invoke('chat.wake',{id});return null;
      case 'reveal':if(folder&&!folder.missing){const error=await shell.openPath(folder.path);if(error)throw new Error(error);}return null;
      case 'open-in':if(folder&&!folder.missing)await service.invoke('files.openFolderWith',{folderId:folder.id,app:command.app});return null;
    }
  }
  async function runFolderMenuCommand(id:string,command:FolderMenuCommand):Promise<Commands['folder.contextMenu']['output']>{
    if(!service||!window||window.isDestroyed())return null;
    const snapshot=await service.invoke('app.snapshot',undefined),folder=snapshot.folders.find(item=>item.id===id);
    if(!folder)throw new Error('Folder no longer exists.');
    switch(command.kind){
      case 'renderer':return command.action;
      case 'reveal':shell.showItemInFolder(folder.path);return null;
      case 'move':await service.invoke('folder.move',{id,direction:command.direction});return null;
      case 'relink':{
        const result=await dialog.showOpenDialog(window,{title:`Relink ${folder.name}`,message:`Choose where “${folder.name}” lives now. Its chats, Projects and memory follow it.`,properties:['openDirectory'],buttonLabel:'Relink'});
        if(result.canceled||!result.filePaths[0])return null;
        const next=await service.invoke('folder.relink',{id,path:result.filePaths[0]});notice(`${next.name} now points to ${next.path}`);return null;
      }
      case 'remove':{
        const live=snapshot.chats.filter(chat=>chat.folderId===id&&!chat.archived).length;
        const {response}=await dialog.showMessageBox(window,{type:'warning',buttons:['Remove','Cancel'],defaultId:1,cancelId:1,message:`Remove “${folder.name}” from the sidebar?`,
          detail:`${live?`${live} chat${live===1?'':'s'} in this folder ${live===1?'is':'are'} archived; restore ${live===1?'it':'them'} and attach a folder to continue. `:''}Nothing on disk is deleted.`});
        if(response!==0)return null;
        await service.invoke('folder.remove',{id,archiveChats:true});notice(`Removed ${folder.name} from the sidebar`);return null;
      }
    }
  }

  async function pickFolder(): Promise<Commands['folder.pick']['output']> {
    if (!window || !service) return null;
    // DF-F1: start next to the folder added most recently (or in the home folder), not wherever macOS last was (~/Downloads).
    const last = (await service.invoke('app.snapshot', undefined)).folders.filter(folder => !folder.missing).at(-1);
    const result = await dialog.showOpenDialog(window, {
      title: 'Add Folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Add Folder',
      defaultPath: last ? path.dirname(last.path) : app.getPath('home'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return service.invoke('folder.add', { path: result.filePaths[0] });
  }

  // --- Menu ----------------------------------------------------------------
  const send = (event: AgentEvent) => window?.webContents.send('muster:event', event);
  // Menu intents go to the renderer, which owns selection and panes. A hidden
  // window (closed on macOS) comes back first so the action is visible.
  const sendMenuAction = (action: MenuAction): void => {
    if (!window || window.isDestroyed() || shutdownStarted) return;
    if (!window.isVisible()) { if (action === 'close-tab') return; if (window.isMinimized()) window.restore(); window.show(); }
    window.focus();
    window.webContents.send(MENU_CHANNEL, action);
  };
  ipcMain.on(MENU_CLOSE_CHANNEL, (event) => {
    if (!isTrustedSender(event.senderFrame, event.sender.id)) return;
    window?.close();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    isMac,
    isPackaged: app.isPackaged,
    helpAvailable: false,
    send: sendMenuAction,
    openHelp: () => {},
    // PER-10: the license bundle written by scripts/dependency-report.mjs ships beside the renderer.
    ...(existsSync(path.join(__dirname, '../renderer/THIRD-PARTY-LICENSES.txt')) ? { openLicenses: () => { void shell.openPath(path.join(__dirname, '../renderer/THIRD-PARTY-LICENSES.txt')); } } : {}),
    toggleDevTools: () => window?.webContents.toggleDevTools(),
    addFolder: () => {
      if(shutdownStarted)return;
      void pickFolder().then((folder) => {
        if (folder) send({ type: 'notice', message: `Added folder ${folder.name}` });
      }).catch((error: Error) => send({ type: 'notice', message: `Could not add folder: ${error.message}` }));
    },
    stopRun: () => {
      if (!service) return;
      void service.invoke('app.snapshot', undefined).then(async (snapshot) => {
        if (snapshot.activeChatId) await service!.invoke('chat.stop', { id: snapshot.activeChatId });
      }).catch((error: Error) => send({ type: 'notice', message: error.message }));
    },
  })));

  // --- Geometry persistence -------------------------------------------------
  const captureGeometry = (): WindowGeometry => {
    if (!window) return DEFAULT_GEOMETRY;
    const maximized = window.isMaximized();
    const bounds = maximized ? window.getNormalBounds() : window.getBounds();
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized };
  };
  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void stateStore.save(captureGeometry()), 500);
  };
  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);

  // --- Lifecycle: never silently cancel long-running work -------------------
  const quit = createQuitCoordinator({
    confirm: async () => {
      if(shutdownStarted)return true;
      const snapshot=await loaded.service.invoke('app.snapshot',undefined);
      const commands=computers.hasActiveWork()||snapshot.chats.some(chat=>processes.hasRunning(chat.id));
      return (runningChats===0&&!commands)||await confirmQuit({runs:runningChats,commands});
    },
    prepare: async () => {
      shutdownStarted=true;
      if (saveTimer) clearTimeout(saveTimer);
      if (window && !window.isDestroyed()) await stateStore.save(captureGeometry());
      if (service) {
        disposal ??= (async()=>{
          // A failing command/container cleanup must never skip provider cancellation.
          const outcomes=await Promise.allSettled([desktopWork.dispose(),loaded.service.dispose()]);
          const failure=outcomes.find(result=>result.status==='rejected');
          if(failure?.status==='rejected')throw failure.reason;
        })().catch(error=>{disposal=undefined;throw error;});
        await withinDeadline(disposal, 5000);
        browserBridge.dispose();
        terminalTools.dispose();
        browserWorkspace.dispose();
        nativePreview.hide();
      }
    },
    exit: () => app.quit(),
    onError: () => dialog.showErrorBox('Muster has not quit', 'Work could not finish stopping or saving yet. The app stayed open. Try Quit again shortly; do not assume background work has stopped.'),
  });
  window.on('close', (event) => {
    // On macOS closing the window keeps the app (and agent runs) alive.
    // Elsewhere close quits, so it gets the same confirmation as quit.
    if (quit.allowed) return;
    event.preventDefault();
    if (quit.pending) return;
    if (isMac) {
      if (saveTimer) clearTimeout(saveTimer);
      void stateStore.save(captureGeometry());
      window?.hide();
      return;
    }
    // Keep the window alive until geometry and runtime checkpointing finish.
    app.quit();
  });
  window.on('closed', () => {
    window = null;
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  app.on('before-quit', (event) => {
    if (quit.allowed) return;
    event.preventDefault();
    void quit.request();
  });

  async function confirmQuit(work:{runs:number;commands:boolean}): Promise<boolean> {
    const prompt = quitPrompt(work);
    const opts = {type: 'warning' as const, buttons: prompt.buttons, defaultId: prompt.defaultId, cancelId: prompt.cancelId, message: prompt.message, detail: prompt.detail};
    const { response } = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, opts)
      : await dialog.showMessageBox(opts);
    const choice = quitChoice(prompt, response);
    if (choice === 'background') keepWorkingInBackground(work.runs);
    return choice === 'stop';
  }

  /** UX-25 "Keep Working in Background": no window in front, runs continue; the Dock icon (or a click on the
   *  notification) brings the window back. Off macOS the window minimizes, since there is no Dock to reopen from. */
  function keepWorkingInBackground(runs: number): void {
    if (window && !window.isDestroyed()) {
      if (saveTimer) clearTimeout(saveTimer);
      void stateStore.save(captureGeometry());
      if (isMac) window.hide(); else window.minimize();
    }
    if (isMac) app.hide();
    if (Notification.isSupported()) {
      const note = new Notification({title: 'Muster is still working', body: runs > 1 ? `${runs} runs continue in the background.` : runs === 1 ? 'Your run continues in the background.' : 'Background commands keep running.', silent: true});
      note.on('click', () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } });
      note.show();
    }
  }

  // --- Load renderer ---------------------------------------------------------
  if (!loaded.runtimeLoaded) {
    window.webContents.once('did-finish-load', () =>
      send({ type: 'notice', message: 'Agent runtime not built; UI is in shell-only mode.' }));
  }
  await window.loadFile(rendererEntry);
  if(pendingChatId)await openLinkedChat(pendingChatId);
}
