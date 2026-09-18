import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentEvent, Commands, Snapshot } from '../shared/protocol.ts';
import { isCommandName } from './commands.ts';
import { buildMenu } from './menu.ts';
import { loadAgentService, type AgentService } from './service-loader.ts';
import { clampGeometry, DEFAULT_GEOMETRY, MIN_HEIGHT, MIN_WIDTH, WindowStateStore, type WindowGeometry } from './window-state.ts';

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
  let quitting = false;
  let disposed = false;

  const stateStore = new WindowStateStore(app.getPath('userData'));

  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
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
    if (!isCommandName(command)) {
      throw new Error('Unknown command.');
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
    return service.invoke(command, input as Commands[typeof command]['input']);
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
      if (!service) return;
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
  window.on('close', (event) => {
    // On macOS closing the window keeps the app (and agent runs) alive.
    // Elsewhere close quits, so it gets the same confirmation as quit.
    if (quitting) return;
    if (isMac) {
      event.preventDefault();
      if (saveTimer) clearTimeout(saveTimer);
      void stateStore.save(captureGeometry());
      window?.hide();
      return;
    }
    if (runningChats === 0) return;
    event.preventDefault();
    void confirmQuit().then((ok) => {
      if (ok) {
        quitting = true;
        window?.close();
      }
    });
  });
  window.on('closed', () => {
    window = null;
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void (async () => {
      if (runningChats > 0 && !(await confirmQuit())) return;
      quitting = true;
      if (saveTimer) clearTimeout(saveTimer);
      if (window && !window.isDestroyed()) await stateStore.save(captureGeometry());
      if (service && !disposed) {
        disposed = true;
        // Give the runtime a bounded chance to checkpoint before exit.
        const { promise: deadline, resolve: expire } = Promise.withResolvers<void>();
        setTimeout(expire, 5000);
        await Promise.race([service.dispose().catch(() => {}), deadline]);
      }
      app.quit();
    })();
  });

  async function confirmQuit(): Promise<boolean> {
    const opts = {
      type: 'warning' as const,
      buttons: ['Quit and Stop Work', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: runningChats === 1 ? 'An agent is still working.' : `${runningChats} agents are still working.`,
      detail: 'Quitting stops in-progress runs. Progress already saved is kept.',
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
}
