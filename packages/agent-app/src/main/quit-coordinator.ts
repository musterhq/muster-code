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
