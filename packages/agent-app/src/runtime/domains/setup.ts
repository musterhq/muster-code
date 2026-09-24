/**
 * R9 setup domain: first-run detection, resumable guide progress, fixed sign-in commands in Terminal, System Settings
 * links, and automatic provider detection (launch, focus, sign-in file changes) that pushes `providersChanged`.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderInfo } from '../../shared/protocol.ts';
import { automaticDefaultModel, isSetupStep, readyProviderSet, type AutoDefaultMemory, SETUP_STEPS, type SetupProgress, type SetupSettingsPane, type SetupStep } from '../../shared/domains/setup-protocol.ts';
import { isCliTool } from '../cli-maintenance.ts';
import { discoverLocalProviders } from '../provider-discovery.ts';
import { createProviderWatch, watchedProviderPaths, type ProviderWatch } from '../provider-watch.ts';
import { detectSetup, shellWord, type SetupDetectionDeps } from '../setup-detection.ts';
import type { DomainContext, DomainModule } from './types.ts';

const EMPTY: SetupProgress = { step: 'welcome', startedAt: null, completedAt: null, dismissedAt: null, skipped: [] };
const PANES: Record<SetupSettingsPane, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
};
const instant = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) throw new Error(`Invalid ${field}.`);
  return value;
};
/** Validates a partial progress update; unknown keys are refused rather than stored. */
export function mergeProgress(current: SetupProgress, input: Record<string, unknown>): SetupProgress {
  const next = { ...current };
  for (const key of Object.keys(input)) if (!(key in EMPTY)) throw new Error(`Unknown setup field ${key}.`);
  if (input.step !== undefined) { if (!isSetupStep(input.step)) throw new Error('Invalid setup step.'); next.step = input.step; }
  for (const key of ['startedAt', 'completedAt', 'dismissedAt'] as const) if (input[key] !== undefined) next[key] = instant(input[key], key);
  if (input.skipped !== undefined) {
    if (!Array.isArray(input.skipped) || !input.skipped.every(isSetupStep)) throw new Error('Invalid skipped steps.');
    next.skipped = SETUP_STEPS.filter(step => (input.skipped as SetupStep[]).includes(step));
  }
  return next;
}
export function parseProgress(text: string): SetupProgress { try { return mergeProgress(EMPTY, JSON.parse(text) as Record<string, unknown>); } catch { return { ...EMPTY }; } }

const run = (file: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(file, args, { timeout: 10_000 }, error => error ? reject(new Error(error.message.split('\n')[0])) : resolve()));

export interface SetupDomainOptions {
  detection?: Partial<SetupDetectionDeps>;
  /** Tests: replace the watch timing/paths, or disable it. */
  watch?: false | { paths?: () => string[]; intervalMs?: number; debounceMs?: number; stat?: (path: string) => string };
  platform?: string;
  open?: (file: string, args: string[]) => Promise<void>;
}

export function createSetupDomain(context: DomainContext, options: SetupDomainOptions = {}): DomainModule {
  const file = join(context.dataDir, 'setup-progress.json');
  const platform = options.platform ?? process.platform, open = options.open ?? run;
  const read = (): SetupProgress => { try { return parseProgress(readFileSync(file, 'utf8')); } catch { return { ...EMPTY }; } };
  const write = (progress: SetupProgress) => {
    mkdirSync(context.dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(progress, null, 2), { mode: 0o600 });
    renameSync(temp, file);
    context.emit({ type: 'setupProgress', progress });
    return progress;
  };
  const list = () => context.invoke('providers.list', undefined) as Promise<ProviderInfo[]>;
  const cliStatus = () => context.invoke('providers.cli.status', {});
  const deps = (): SetupDetectionDeps => ({ providers: list, cliStatus, discovered: () => discoverLocalProviders(), platform, ...options.detection });

  // The automatic default never overrides a deliberate choice: it is applied at most once per set of ready providers,
  // and never again once the user set, changed or reset the default model (UI, reset or settings import).
  const memoryFile = join(context.dataDir, 'setup-default-model.json');
  const readMemory = (): AutoDefaultMemory => {
    try { const raw = JSON.parse(readFileSync(memoryFile, 'utf8')) as Partial<AutoDefaultMemory>; return { userSetAt: typeof raw.userSetAt === 'string' ? raw.userSetAt : null, auto: raw.auto && typeof raw.auto === 'object' && typeof raw.auto.providers === 'string' ? raw.auto : null }; }
    catch { return { userSetAt: null, auto: null }; }
  };
  const writeMemory = (memory: AutoDefaultMemory) => {
    mkdirSync(context.dataDir, { recursive: true });
    const temp = `${memoryFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(memory, null, 2), { mode: 0o600 }); renameSync(temp, memoryFile);
  };
  let ownWrite = false;
  const offCommand = context.hooks?.onCommand?.(({ command, input, output }) => {
    const touched = command === 'settings.set' ? input.key === 'general.defaultModel'
      : command === 'settings.reset' ? !Array.isArray(input.keys) || (input.keys as unknown[]).includes('general.defaultModel')
      : command === 'settings.import' ? Array.isArray((output as { applied?: unknown })?.applied) && ((output as { applied: unknown[] }).applied).includes('general.defaultModel')
      : false;
    if (touched && !ownWrite) writeMemory({ ...readMemory(), userSetAt: new Date().toISOString() });
  });
  let watch: ProviderWatch | undefined, launch: ReturnType<typeof setTimeout> | undefined;
  // Test runners build many services against the real home; they opt in by passing `watch`.
  const watching = options.watch === undefined ? !process.env.NODE_TEST_CONTEXT : options.watch !== false;
  if (watching) {
    const tuning = options.watch || {};
    watch = createProviderWatch({
      list, paths: tuning.paths ?? (() => watchedProviderPaths({ dataDir: context.dataDir })),
      ...(tuning.stat ? { stat: tuning.stat } : {}), ...(tuning.intervalMs ? { intervalMs: tuning.intervalMs } : {}), ...(tuning.debounceMs ? { debounceMs: tuning.debounceMs } : {}),
      ...(context.modelCatalogReady ? { ready: context.modelCatalogReady } : {}),
      emit: change => context.emit({ type: 'providersChanged', ...change }),
      onReady: async providers => {
        const memory = readMemory();
        if (memory.userSetAt) return;
        const current = (await context.invoke('settings.get', {})).values['general.defaultModel'];
        const pick = automaticDefaultModel(providers, current, memory);
        if (!pick) return;
        ownWrite = true;
        try { await context.invoke('settings.set', { key: 'general.defaultModel', value: pick }); }
        finally { ownWrite = false; }
        writeMemory({ ...readMemory(), auto: { appliedAt: new Date().toISOString(), ...pick, providers: readyProviderSet(providers) } });
      },
    });
    // Deferred so every domain (providers, settings) is registered before the launch probe invokes them.
    launch = setTimeout(() => { void watch?.start(); }, 0); launch.unref?.();
  }

  return {
    handlers: {
      'setup.status': async () => { await context.modelCatalogReady?.().catch(() => undefined); return detectSetup(deps()); },
      'setup.refresh': async () => ({ providers: watch ? await watch.refresh() : await list() }),
      'setup.progress': () => read(),
      'setup.saveProgress': input => write(mergeProgress(read(), input)),
      'setup.openTerminal': async input => {
        const tool = input.tool;
        if (!isCliTool(tool)) throw new Error('Choose Codex, Claude Code or OpenCode.');
        const cli = (await detectSetup({ ...deps(), run: async () => ({ ok: false, stdout: '', stderr: '' }) })).clis.find(row => row.tool === tool)!;
        if (!cli.installed) throw new Error(`${cli.label} is not installed yet. Install it first.`);
        if (platform !== 'darwin') return { opened: false, command: cli.loginCommand };
        // A .command file opens in Terminal without Automation permission. Its content is fixed per tool.
        const dir = join(context.dataDir, 'setup');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const script = join(dir, `${tool}-sign-in.command`);
        writeFileSync(script, `#!/bin/sh\necho ${shellWord(`Muster: signing in to ${cli.label}. Follow the prompts, then return to Muster.`)}\n"\${SHELL:-/bin/zsh}" -l -c ${shellWord(cli.loginCommand)}\necho\necho 'You can close this window. Muster picks up the sign-in automatically.'\n`, { mode: 0o700 });
        chmodSync(script, 0o700);
        await open('/usr/bin/open', ['-a', 'Terminal', script]);
        return { opened: true, command: cli.loginCommand };
      },
      'setup.openSystemSettings': async input => {
        const url = typeof input.pane === 'string' && Object.hasOwn(PANES, input.pane) ? PANES[input.pane as SetupSettingsPane] : undefined;
        if (!url) throw new Error('Unknown settings pane.');
        if (platform !== 'darwin') throw new Error('System Settings is available on macOS only.');
        await open('/usr/bin/open', [url]);
      },
    },
    dispose() { if (launch) clearTimeout(launch); watch?.dispose(); offCommand?.(); },
  };
}
