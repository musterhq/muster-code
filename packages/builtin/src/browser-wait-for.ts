export type WaitForConditions = { text?: string; selector?: string; url?: string; timeMs?: number };

export function waitForCheckJs(conditions: WaitForConditions): string {
  const parts: string[] = [];
  if (conditions.text) parts.push(`document.body && document.body.innerText.includes(${JSON.stringify(conditions.text)})`);
  if (conditions.selector) parts.push(`!!document.querySelector(${JSON.stringify(conditions.selector)})`);
  if (conditions.url) {
    const raw = conditions.url;
    let isRegex = false;
    try {
      if (raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
        const last = raw.lastIndexOf("/");
        const body = raw.slice(1, last);
        const flags = raw.slice(last + 1);
        parts.push(`new RegExp(${JSON.stringify(body)}, ${JSON.stringify(flags)}).test(location.href)`);
        isRegex = true;
      }
    } catch { /* fall through */ }
    if (!isRegex) parts.push(`location.href.includes(${JSON.stringify(raw)})`);
  }
  if (!parts.length) return "true";
  return `(() => { try { return ${parts.join(" && ")}; } catch { return false; } })()`;
}

export function failedWaitForLabel(conditions: WaitForConditions): string {
  if (conditions.text) return "text";
  if (conditions.selector) return "selector";
  if (conditions.url) return "url";
  return "timeMs";
}

export async function runWaitFor(
  conditions: WaitForConditions,
  opts: { timeoutMs: number; pollMs: number; evalJs: (js: string) => Promise<unknown>; sleep: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ ok: true } | { ok: false; failed: string }> {
  const hasCondition = !!(conditions.text || conditions.selector || conditions.url);
  const delay = Math.max(0, Number(conditions.timeMs) || 0);
  if (!hasCondition) {
    await opts.sleep(delay || 1000);
    return { ok: true };
  }
  if (delay > 0) await opts.sleep(delay);
  const until = (opts.now ?? Date.now)() + opts.timeoutMs;
  const js = waitForCheckJs(conditions);
  while ((opts.now ?? Date.now)() < until) {
    if ((await opts.evalJs(js)) === true) return { ok: true };
    await opts.sleep(opts.pollMs);
  }
  return { ok: false, failed: failedWaitForLabel(conditions) };
}
