/** Plain, credential-free explanations of transport errors, including fetch's nested cause. */
export function networkFailure(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  function visit(value: unknown, depth = 0): void {
    if (!value || seen.has(value) || depth > 5) return;
    seen.add(value);
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'object') {
      const e = value as Record<string, unknown>;
      for (const key of ['message', 'code']) if (typeof e[key] === 'string') parts.push(e[key] as string);
      for (const key of ['statusCode', 'httpStatusCode', 'status']) if (e[key] === 429) parts.push('429');
      visit(e.cause, depth + 1);
      for (const child of Object.values(e).slice(0, 20)) if (child && typeof child === 'object') visit(child, depth + 1);
      if (Array.isArray(e.errors)) for (const child of e.errors.slice(0, 10)) visit(child, depth + 1);
    }
  }
  visit(error);
  const text = parts.join(' ');
  // Admission retries belong to the existing rate-limit path, even when a proxy reports them.
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) return undefined;
  if (/proxy|tunnel/i.test(text)) return 'Could not connect through the HTTPS proxy. Check your proxy settings.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns|name.*resol/i.test(text)) return 'The provider address could not be found (DNS). Check your network and DNS settings.';
  if (/CERT_|certificate|\bTLS\b|\bSSL\b|self.signed/i.test(text)) return 'The secure connection failed (TLS certificate). Check your certificate and proxy settings.';
  if (/ECONNREFUSED|connection refused|connect.*refused/i.test(text)) return 'The connection was refused. Check that the provider or proxy is reachable.';
  if (/fetch failed|ECONNRESET|ETIMEDOUT|timed? ?out|connection.*(?:closed|reset)|stream disconnected|network (?:error|unreachable)|error sending request/i.test(text)) return 'The network connection to the provider failed. Check your network and proxy settings.';
  return undefined;
}

export const MAX_NETWORK_RECONNECTS = 3;
export const NETWORK_RECONNECT_DEADLINE_MS = 30_000;

/** Bounds a provider's own reconnect loop, including a retry that stops sending events. */
export function networkReconnectGuard() {
  let count = 0, reason = '', timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (reason: string) => void;
  const failed = new Promise<string>(done => { resolve = done; });
  const progress = () => { count = 0; if (timer) clearTimeout(timer); timer = undefined; };
  return {
    failed, progress, dispose: progress,
    observe(params: Record<string, unknown>) {
      const error = params.error as Record<string, unknown> | undefined;
      if (params.willRetry !== true) return;
      if (error?.statusCode === 429 || error?.httpStatusCode === 429 || error?.code === 429) { progress(); return; }
      const cause = networkFailure(error);
      if (!cause) { progress(); return; }
      reason = cause;
      if (!timer) timer = setTimeout(() => resolve(reason), NETWORK_RECONNECT_DEADLINE_MS);
      if (++count >= MAX_NETWORK_RECONNECTS) { progress(); resolve(reason); }
    },
  };
}
