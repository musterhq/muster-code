/**
 * #449: an update install never cuts running turns short. While any chat is working, Install waits, says so once,
 * and runs by itself when the last run settles. A quit the user starts themselves still asks first, as before.
 */
export interface UpdateGate<T> {
  /** Installs now, or defers while work runs (returns undefined then). */
  install(): Promise<T | undefined>;
  /** Call whenever the running count may have changed; a deferred install starts once nothing runs. */
  idle(): void;
  readonly waiting: boolean;
}
export const UPDATE_DEFERRED_NOTE = 'Muster will update when the running work finishes.';
export function createUpdateGate<T>(options: { running(): number; install(): Promise<T>; notify(message: string): void }): UpdateGate<T> {
  let waiting = false;
  return {
    async install() {
      if (options.running() > 0) {
        if (!waiting) { waiting = true; options.notify(UPDATE_DEFERRED_NOTE); }
        return undefined;
      }
      waiting = false;
      return options.install();
    },
    idle() {
      if (!waiting || options.running() > 0) return;
      waiting = false;
      void options.install().catch(() => undefined);
    },
    get waiting() { return waiting; },
  };
}
