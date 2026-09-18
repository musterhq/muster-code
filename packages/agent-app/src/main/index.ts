import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session } from 'electron';
import path from 'node:path';
import type { AgentEvent, Commands, Snapshot } from '../shared/protocol.ts';
import { isCommandName } from './commands.ts';
import { buildMenu } from './menu.ts';
import { loadAgentService, type AgentService } from './service-loader.ts';
import { clampGeometry, DEFAULT_GEOMETRY, MIN_HEIGHT, MIN_WIDTH, WindowStateStore, type WindowGeometry } from './window-state.ts';

// Single instance: second launch focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
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
      window.focus();
    }
  });

  await app.whenReady();

  // --- Agent service -------------------------------------------------------
  const dataDir = path.join(app.getPath('userData'), 'agent-data');
  const onEvent = (event: AgentEvent): void => {
    if (event.type === 'snapshot') {
      runningChats = event.snapshot.chats.filter((c) => c.status === 'running' || c.status === 'stopping').length;
    }
    if (window && !window.isDestroyed()) {
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
    title: 'Muster Code',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    ...(wantsVibrancy
      ? { vibrancy: 'sidebar' as const, transparent: false }
      : { backgroundColor: '#1e1e20' }),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/index.cjs'),
      spellcheck: false,
    },
  });
  if (geometry.maximized) window.maximize();
  window.once('ready-to-show', () => window?.show());

  // --- Navigation hardening: renderer is app-local only --------------------
  const appOrigin = 'file://';
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appOrigin)) event.preventDefault();
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  // --- IPC: single validated entry point -----------------------------------
  const isTrustedSender = (frame: Electron.WebFrameMain | null, senderId: number): boolean =>
    window !== null && !window.isDestroyed() &&
    senderId === window.webContents.id &&
    frame !== null && frame === window.webContents.mainFrame &&
    frame.url.startsWith(appOrigin);

  ipcMain.handle('muster:invoke', async (event, command: unknown, input: unknown) => {
    if (!isTrustedSender(event.senderFrame, event.sender.id)) {
      throw new Error('Rejected IPC from untrusted sender.');
    }
    if (!isCommandName(command)) {
      throw new Error('Unknown command.');
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
      } catch (error) {
        send({ type: 'notice', message: `Could not create chat: ${(error as Error).message}` });
      }
    },
    addFolder: () => {
      void pickFolder().then((folder) => {
        if (folder) send({ type: 'notice', message: `Added folder ${folder.name}` });
      }).catch((error: Error) => send({ type: 'notice', message: `Could not add folder: ${error.message}` }));
    },
    stopRun: () => send({ type: 'notice', message: 'Use the stop control on the running chat.' }),
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
    if (isMac || quitting || runningChats === 0) return;
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
  await window.loadFile(path.join(__dirname, '../renderer/index.html'));
}
