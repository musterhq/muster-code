import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, clipboard } from 'electron';
import path from 'node:path';
import {createRequire} from 'node:module';
import {ProcessSessions} from '../runtime/process-sessions.ts';
import {ScopedComputers} from '../runtime/scoped-computers.ts';
import {DesktopWorkspaces,commandAuthority,computerAuthority} from './desktop-workspaces.ts';
import { pathToFileURL } from 'node:url';
import type { AgentEvent, Commands, Snapshot } from '../shared/protocol.ts';
import { isCommandName } from './commands.ts';
import { fileOperation, mutablePath } from '../runtime/file-operations.ts';
import {BrowserWorkspaceController} from './browser-workspace.ts';
import {NativePreviewController} from './native-preview.ts';
import { buildMenu } from './menu.ts';
import { createQuitCoordinator, withinDeadline } from './quit-coordinator.ts';
import { loadAgentService, type AgentService } from './service-loader.ts';
import { clampGeometry, DEFAULT_GEOMETRY, MIN_HEIGHT, MIN_WIDTH, WindowStateStore, type WindowGeometry } from './window-state.ts';
import {chatIdFromArgs,chatIdFromLink} from './chat-links.ts';

app.setName('Muster Agent');
app.setPath('userData', app.commandLine.getSwitchValue('user-data-dir') || path.join(app.getPath('appData'), 'Muster Agent'));

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

  // Match the dark renderer with the dark native sidebar material.
  nativeTheme.themeSource = 'dark';
  await app.whenReady();
  app.setAsDefaultProtocolClient('muster');

  // --- Agent service -------------------------------------------------------
  const dataDir = path.join(app.getPath('userData'), 'agent-data');
  const onEvent = (event: AgentEvent): void => {
    if (event.type === 'snapshot') {
      runningChats = event.snapshot.chats.filter((c) => c.status === 'running' || c.status === 'stopping').length;
    }
    if (window && !window.isDestroyed() && window.isVisible()) {
      window.webContents.send('muster:event', event);
    }
  };
  const loaded = loadAgentService({ dataDir, onEvent });
  service = loaded.service;
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
  const processes = new ProcessSessions(path.join(dataDir,'process-sessions.json'),async input=>commandAuthority(await loaded.service.invoke('app.snapshot',undefined),dataDir,input),onEvent);
  const computers = new ScopedComputers({
    appData:dataDir,
    resolveScope:async scope=>computerAuthority(await loaded.service.invoke('app.snapshot',undefined),scope),
    loadCore:async()=>createRequire(__filename)(path.join(__dirname,'../runtime/scoped-computer-core.cjs')),
  });
  const desktopWork = new DesktopWorkspaces(loaded.service,processes,computers);

  // --- Window --------------------------------------------------------------
  const saved = await stateStore.load();
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  const geometry = clampGeometry(saved ?? DEFAULT_GEOMETRY, displays);

  const isMac = process.platform === 'darwin';
  // Vibrancy only when the OS is not asked to reduce transparency; the
  // renderer keeps content panes opaque and only the sidebar shows through.
  const wantsVibrancy = isMac && !nativeTheme.prefersReducedTransparency;

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
      ? { vibrancy: 'sidebar' as const, transparent: false }
      : { backgroundColor: '#181818' }),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.cjs'),
      spellcheck: false,
      // A visible Agent window must paint streaming text and resize changes
      // even while another app has keyboard focus. Hidden windows are throttled below.
      backgroundThrottling: false,
    },
  });
  const nativePreview = new NativePreviewController(window);
  const browserWorkspace = new BrowserWorkspaceController(window, onEvent);
  window.on('hide',()=>nativePreview.hide());
  window.on('closed',()=>nativePreview.hide());
  window.webContents.on('did-start-loading',()=>{nativePreview.hide();processes.detachAll();});
  if (geometry.maximized) window.maximize();
  window.once('ready-to-show', () => window?.show());
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
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
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
        if(!request||typeof request.id!=='string'||request.id.length>256||!Number.isFinite(request.x)||!Number.isFinite(request.y))throw new Error('Invalid chat menu request.');
        if(!service||!window||window.isDestroyed())throw new Error('Agent service is unavailable.');
        const snapshot=await service.invoke('app.snapshot',undefined);
        const chat=snapshot.chats.find(item=>item.id===request.id);
        if(!chat)throw new Error('Chat no longer exists.');
        const folder=chat.folderId?snapshot.folders.find(item=>item.id===chat.folderId):undefined;
        type Action=Commands['chat.contextMenu']['output'];
        const options:Electron.MenuItemConstructorOptions[]=[];
        const item=(label:string,action:Exclude<Action,null>)=>options.push({label,click:()=>finish(action)});
        let finish:(action:Action)=>void=()=>{};
        if(chat.pinned&&!chat.archived){item('Unpin Chat','pin');options.push({type:'separator'});}
        else item('Pin Chat','pin');
        item('Rename…','rename');
        options.push({type:'separator'});
        item('Open Command Activity','activity');
        if(folder)item('Open Files and Changes','files');
        item('Copy Local Chat Link','copy-link');
        if(chat.pinned&&!chat.archived){options.push({type:'separator'});item('Move Pin Up','pin-up');item('Move Pin Down','pin-down');}
        options.push({type:'separator'});
        item(chat.archived?'Restore Chat':'Archive Chat','archive');
        const nativeMenu=Menu.buildFromTemplate(options);
        const scale=window.webContents.getZoomFactor()||1;
        return await new Promise<Action>(resolve=>{
          finish=resolve;
          nativeMenu.popup({window:window!,x:Math.round(request.x/scale),y:Math.round(request.y/scale),callback:()=>resolve(null)});
        });
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
    return desktopWork.invoke(command, input as Commands[typeof command]['input']);
  });

  async function pickFolder(): Promise<Commands['folder.pick']['output']> {
    if (!window || !service) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Add Folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Add Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return service.invoke('folder.add', { path: result.filePaths[0] });
  }

  // --- Menu ----------------------------------------------------------------
  const send = (event: AgentEvent) => window?.webContents.send('muster:event', event);
  Menu.setApplicationMenu(buildMenu(() => window, {
    newChat: async () => {
      if (!service || shutdownStarted) return;
      try {
        const chat = await service.invoke('chat.create', {});
        const snapshot = await service.invoke('app.snapshot', undefined) as Snapshot;
        send({ type: 'snapshot', snapshot: { ...snapshot, activeChatId: chat.id } });
        send({type:'chatSelected',chatId:chat.id});
      } catch (error) {
        send({ type: 'notice', message: `Could not create chat: ${(error as Error).message}` });
      }
    },
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
  }));

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
      return (runningChats===0&&!computers.hasActiveWork()&&!snapshot.chats.some(chat=>processes.hasRunning(chat.id)))||await confirmQuit();
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

  async function confirmQuit(): Promise<boolean> {
    const opts = {
      type: 'warning' as const,
      buttons: ['Quit and Stop Work', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Muster has work running.',
      detail: 'Quitting stops agent runs and owned background commands. Scoped computer workspaces and saved progress are kept.',
    };
    const { response } = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, opts)
      : await dialog.showMessageBox(opts);
    return response === 0;
  }

  // --- Load renderer ---------------------------------------------------------
  if (!loaded.runtimeLoaded) {
    window.webContents.once('did-finish-load', () =>
      send({ type: 'notice', message: 'Agent runtime not built; UI is in shell-only mode.' }));
  }
  await window.loadFile(rendererEntry);
  if(pendingChatId)await openLinkedChat(pendingChatId);
}
