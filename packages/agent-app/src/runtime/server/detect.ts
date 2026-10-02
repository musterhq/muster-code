/**
 * Which server is this URL? Nobody should have to say: Paperclip answers `GET /api/health` with its status and deployment mode,
 * a Muster Server answers `GET /healthz` with its version and runtime state. Probes are plain GETs with no credentials.
 */
import type { ServerBackendKind } from '../../shared/domains/paperclip-protocol.ts';
import type { FetchLike } from '../paperclip-client.ts';

export interface Detected { kind: ServerBackendKind; version?: string; deploymentMode?: string; origin: string }
export type Detection = ({ ok: true } & Detected) | { ok: false; stage: 'network' | 'service'; message: string };
const PROBE_MS = 4_000;
type Probe = { status: number; body: Record<string, unknown> | null } | null;

async function probe(fetcher: FetchLike, url: string): Promise<Probe> {
  try {
    const response = await fetcher(url, { method: 'GET', headers: { accept: 'application/json', 'x-muster-probe': 'detect' }, redirect: 'error', signal: AbortSignal.timeout(PROBE_MS) });
    const text = await response.text().catch(() => '');
    let body: Record<string, unknown> | null = null;
    try { const parsed = JSON.parse(text) as unknown; body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { /* not JSON */ }
    return { status: response.status, body };
  } catch { return null; }
}
const str = (v: unknown) => typeof v === 'string' && v ? v : undefined;

/** Pure classification of the two probe answers (tests feed recorded bodies). */
export function classify(paperclip: Probe, muster: Probe, origin: string): Detection {
  const mb = muster?.status === 200 ? muster.body : null;
  // A Muster Server's health names its runtime state; Paperclip's never does.
  if (mb && mb.ok === true && typeof mb.runtime === 'string' && str(mb.version)) return { ok: true, kind: 'muster-server', version: str(mb.version), origin };
  const pb = paperclip?.status === 200 ? paperclip.body : null;
  if (pb && (pb.status === 'ok' || str(pb.deploymentMode)) && !('runtime' in pb)) return { ok: true, kind: 'paperclip', version: str(pb.version), deploymentMode: str(pb.deploymentMode), origin };
  if (!paperclip && !muster) return { ok: false, stage: 'network', message: `Nothing answered at ${origin}. Check the address and that the server is running.` };
  return { ok: false, stage: 'service', message: `This URL isn’t a Muster Server API: ${origin} did not answer with a server health reply (it may be a web page). Check the address (use the server’s own URL, for example https://muster.example.com).` };
}

export async function detectBackend(baseUrl: string, fetcher: FetchLike = (input, init) => fetch(input, init)): Promise<Detection> {
  const origin = baseUrl.replace(/\/+$/, '');
  const [paperclip, muster] = await Promise.all([probe(fetcher, `${origin}/api/health`), probe(fetcher, `${origin}/healthz`)]);
  return classify(paperclip, muster, origin);
}
