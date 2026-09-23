/** Serialize confirmation and checkpointing. Only successful cleanup permits exit. */
export function createQuitCoordinator(options: {
  confirm(): Promise<boolean>;
  prepare(): Promise<void>;
  exit(): void;
  onError(error: unknown): void;
}) {
  let allowed = false;
  let pending: Promise<void> | undefined;
  return {
    get allowed() { return allowed; },
    get pending() { return pending !== undefined; },
    request(): Promise<void> {
      if (allowed) return Promise.resolve();
      if (pending) return pending;
      // Defer even confirmation until pending is assigned (reentrant callers).
      pending = Promise.resolve().then(async () => {
        if (!(await options.confirm())) return;
        await options.prepare();
        allowed = true;
        options.exit();
      }).catch(error => { options.onError(error); }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}

export async function withinDeadline(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Work is still stopping. Muster stayed open to protect saved progress. Try Quit again shortly.')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** UX-25: what Quit does while work is running. 'background' keeps the process (and every run) alive with
 *  no window in front; 'stop' stops runs and quits; 'cancel' changes nothing. */
export type QuitChoice = 'background' | 'stop' | 'cancel';
export interface QuitPrompt { buttons: string[]; defaultId: number; cancelId: number; message: string; detail: string; choices: QuitChoice[] }

export function quitPrompt(work: {runs: number; commands: boolean}): QuitPrompt {
  const runs = work.runs === 1 ? '1 agent run is' : work.runs > 1 ? `${work.runs} agent runs are` : '';
  const what = runs && work.commands ? `${runs} running, with background commands.` : runs ? `${runs} running.` : 'Background commands are running.';
  return {
    buttons: ['Keep Working in Background', 'Stop Work and Quit', 'Cancel'],
    choices: ['background', 'stop', 'cancel'],
    // Neither default loses work: Return keeps working with the window closed, Escape cancels.
    defaultId: 0,
    cancelId: 2,
    message: 'Muster has work running.',
    detail: `${what} Keep working closes the window and lets them finish; click the Dock icon to return. Stop Work and Quit stops agent runs and owned background commands. Scoped computer workspaces and saved progress are kept either way.`,
  };
}

export function quitChoice(prompt: QuitPrompt, response: number): QuitChoice {
  return prompt.choices[response] ?? 'cancel';
}
