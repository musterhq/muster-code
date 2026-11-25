import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

interface FirstLaunchOptions {
  userData: string;
  endpoint: string;
  disabled: boolean;
  fetcher?: typeof fetch;
}

/** Called by the single-instance owner before the runtime creates agent-data. */
export async function reportFirstLaunch({userData, endpoint, disabled, fetcher = fetch}: FirstLaunchOptions): Promise<void> {
  if (disabled || !endpoint) return;
  const pending = join(userData, 'install-count.pending');
  const counted = join(userData, 'install-count.recorded');
  try {
    if (existsSync(counted)) return;
    if (!existsSync(pending)) {
      // All previous desktop releases store their local runtime under agent-data.
      if (existsSync(join(userData, 'agent-data'))) return;
      mkdirSync(userData, {recursive: true});
      writeFileSync(pending, randomUUID(), {flag: 'wx', mode: 0o600});
    }
    const id = readFileSync(pending, 'utf8');
    // A partial write or edited marker must never be uploaded as profile data.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || id.length !== 36) return;
    const response = await fetcher(endpoint, {
      method: 'POST', body: id, redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 204) renameSync(pending, counted);
    else await response.body?.cancel();
  } catch {
    // Startup stays usable offline. Retry the same ID on the next launch.
  }
}
