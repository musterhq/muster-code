import type { AgentBridge, AgentEvent, Commands } from '../shared/protocol';

/**
 * Single access point to the preload bridge. Every capability shown in the UI
 * must route through here; absence of the bridge renders an explicit
 * "runtime unavailable" surface rather than fake behavior.
 */
export function getBridge(): AgentBridge | null {
  return typeof window !== 'undefined' && window.muster ? window.muster : null;
}

export class BridgeError extends Error {
  constructor(
    readonly command: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'BridgeError';
  }
}

export async function invoke<K extends keyof Commands>(
  command: K,
  input: Commands[K]['input'],
): Promise<Commands[K]['output']> {
  const bridge = getBridge();
  if (!bridge) throw new BridgeError(command, 'Agent runtime is not connected');
  try {
    return await bridge.invoke(command, input);
  } catch (cause) {
    throw new BridgeError(command, cause);
  }
}

export function subscribe(listener: (event: AgentEvent) => void): () => void {
  const bridge = getBridge();
  if (!bridge) return () => {};
  return bridge.subscribe(listener);
}
