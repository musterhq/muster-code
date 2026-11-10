/**
 * `dictation.*` (#840): the transcription backends behind the composer's mic, chosen in Settings › Chat.
 *
 * - `cloud`: an OpenAI-compatible `POST <endpoint>/audio/transcriptions` with the person's own key, either a saved
 *   provider connection (its endpoint and key) or an endpoint and key entered for dictation (the key is encrypted in
 *   the secret store). This is the only backend that sends audio anywhere.
 * - `macos` (on-device speech) and `local` (a local model) are listed so the choice is visible, but this build does
 *   not ship them: they are reported unavailable and never transcribe.
 *
 * The recording arrives as base64, is posted once and dropped: it is never written to disk or logged, and errors
 * never quote it. Only the choice (backend, connection, endpoint, model) is stored, in dataDir/dictation.json.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DICTATION_BACKENDS, DICTATION_MAX_AUDIO_BYTES, type DictationBackendId, type DictationBackendView, type DictationConfigInput,
  type DictationConfigView, type MicrophoneAccess,
} from '../../shared/domains/dictation-protocol.ts';
import { activeCustomProviders, resolveCustomKey, validateEndpoint, type CustomConnection } from '../custom-providers.ts';
import { activeSecretStore, type SecretStore } from '../secret-store.ts';
import type { DomainContext, DomainModule } from './types.ts';

export const DICTATION_SECRET_ID = 'dictation-cloud';
const DEFAULT_MODEL = 'whisper-1';
const CHOOSE = 'Choose a dictation service in Settings › Chat.';
const LABELS: Record<DictationBackendId, string> = { off: 'Off', cloud: 'Cloud', macos: 'On-device (macOS)', local: 'Local model' };
const TIMEOUT_MS = 120_000;
const MAX_ANSWER_BYTES = 1024 * 1024;
const MIME = /^audio\/[a-z0-9.+-]{1,40}(?:;\s*codecs="?[a-z0-9.,-]{1,40}"?)?$/i;
const MODEL = /^[A-Za-z0-9._:/-]{1,128}$/;
const CONNECTION = /^[A-Za-z0-9_-]{1,128}$/;

interface Stored { version: 1; backend: DictationBackendId; connectionId: string | null; endpoint: string; model: string }
const DEFAULTS: Stored = { version: 1, backend: 'off', connectionId: null, endpoint: '', model: DEFAULT_MODEL };

export interface DictationDomainOptions {
  fetch?: typeof fetch;
  secrets?: () => SecretStore | undefined;
  /** Saved OpenAI-compatible connections (Settings › Providers). */
  connections?: () => CustomConnection[];
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

function extension(mime: string): string {
  const type = mime.split(';')[0]!.trim().toLowerCase();
  return type === 'audio/webm' ? 'webm' : type === 'audio/ogg' ? 'ogg' : type === 'audio/mp4' || type === 'audio/m4a' || type === 'audio/x-m4a' ? 'm4a'
    : type === 'audio/mpeg' || type === 'audio/mp3' ? 'mp3' : type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave' ? 'wav' : type === 'audio/flac' ? 'flac' : 'webm';
}
function failure(status: number): string {
  if (status === 401 || status === 403) return `The transcription service rejected the API key (HTTP ${status}). Check the key in Settings › Chat.`;
  if (status === 404 || status === 405) return 'This endpoint does not offer /audio/transcriptions. Choose a service that supports speech to text in Settings › Chat.';
  if (status === 413) return 'The recording is too long for the transcription service. Try a shorter one.';
  if (status === 429) return 'The transcription service is rate limiting requests (HTTP 429). Wait a moment and try again.';
  return `The transcription service returned HTTP ${status}.`;
}

export function createDictationDomain(context: Pick<DomainContext, 'dataDir'>, options: DictationDomainOptions = {}): DomainModule {
  const file = join(context.dataDir, 'dictation.json');
  const request = options.fetch ?? fetch;
  const secrets = options.secrets ?? activeSecretStore;
  const connections = options.connections ?? (() => activeCustomProviders()?.connections() ?? []);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const inflight = new Set<AbortController>();

  const read = (): Stored => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>;
      return {
        version: 1,
        backend: DICTATION_BACKENDS.includes(raw.backend as DictationBackendId) ? raw.backend as DictationBackendId : DEFAULTS.backend,
        connectionId: typeof raw.connectionId === 'string' && CONNECTION.test(raw.connectionId) ? raw.connectionId : null,
        endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
        model: typeof raw.model === 'string' && MODEL.test(raw.model) ? raw.model : DEFAULT_MODEL,
      };
    } catch { return { ...DEFAULTS }; }
  };
  const write = (value: Stored) => {
    mkdirSync(context.dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temp, file);
    try { chmodSync(file, 0o600); } catch { /* filesystems without modes */ }
  };
  const backends = (): DictationBackendView[] => DICTATION_BACKENDS.map(id => {
    if (id === 'off' || id === 'cloud') return { id, label: LABELS[id], available: true };
    if (id === 'macos') return { id, label: LABELS[id], available: false, reason: platform === 'darwin' ? 'On-device macOS speech is not in this version yet.' : 'On-device speech is available on macOS only.' };
    return { id, label: LABELS[id], available: false, reason: 'A local speech model is not in this version yet.' };
  });
  /** Where the cloud request goes and with which key; a reason instead when it cannot go anywhere. */
  const target = (stored: Stored): { endpoint: string; key?: string } | { reason: string } => {
    if (stored.connectionId) {
      const row = connections().find(entry => entry.id === stored.connectionId);
      if (!row) return { reason: 'The provider connection chosen for dictation was removed. Choose another in Settings › Chat.' };
      const key = resolveCustomKey(row, env, secrets());
      if ((row.apiKeyEnv || secrets()?.status(row.id).stored) && !key) return { reason: `The key for ${row.name} could not be read. Paste it again in Settings › Providers.` };
      try { return { endpoint: validateEndpoint(row.endpoint), ...(key ? { key } : {}) }; } catch (error) { return { reason: (error as Error).message }; }
    }
    if (!stored.endpoint) return { reason: 'Enter the transcription endpoint in Settings › Chat.' };
    const key = secrets()?.get(DICTATION_SECRET_ID);
    return { endpoint: stored.endpoint, ...(key ? { key } : {}) };
  };
  const view = (stored = read()): DictationConfigView => {
    const store = secrets();
    const cloud = { connectionId: stored.connectionId, endpoint: stored.endpoint, model: stored.model, keyStored: Boolean(store?.status(DICTATION_SECRET_ID).stored), secureStorage: Boolean(store?.secureStorage()) };
    const option = backends().find(entry => entry.id === stored.backend)!;
    let reason: string | undefined;
    if (stored.backend === 'off') reason = CHOOSE;
    else if (!option.available) reason = `${option.reason} ${CHOOSE}`;
    else { const where = target(stored); if ('reason' in where) reason = where.reason; }
    return { backend: stored.backend, ready: !reason, ...(reason ? { reason } : {}), backends: backends(), cloud };
  };
  const set = (raw: Record<string, unknown>): DictationConfigView => {
    const input = raw as DictationConfigInput;
    const next = read();
    if (input.backend !== undefined) {
      if (!DICTATION_BACKENDS.includes(input.backend)) throw new Error('Choose Off, Cloud, On-device or Local model.');
      next.backend = input.backend;
    }
    if (input.connectionId !== undefined) {
      if (input.connectionId !== null && (typeof input.connectionId !== 'string' || !CONNECTION.test(input.connectionId) || !connections().some(entry => entry.id === input.connectionId))) throw new Error('Choose a saved provider connection.');
      next.connectionId = input.connectionId;
    }
    if (input.endpoint !== undefined) {
      if (typeof input.endpoint !== 'string') throw new Error('Enter a valid API base URL.');
      const trimmed = input.endpoint.trim().replace(/\/+$/, '').replace(/\/audio\/transcriptions$/i, '');
      next.endpoint = trimmed ? validateEndpoint(trimmed) : '';
    }
    if (input.model !== undefined) {
      const model = typeof input.model === 'string' ? input.model.trim() : '';
      if (!MODEL.test(model)) throw new Error('Enter a transcription model name, such as whisper-1.');
      next.model = model;
    }
    if (input.apiKey !== undefined) {
      const store = secrets();
      if (input.apiKey === null || input.apiKey === '') store?.clear(DICTATION_SECRET_ID);
      else { if (!store) throw new Error('Secure storage is unavailable, so the key was not saved.'); store.set(DICTATION_SECRET_ID, input.apiKey); }
    }
    write(next);
    return view(next);
  };
  const transcribe = async (raw: Record<string, unknown>): Promise<{ text: string }> => {
    const stored = read(), current = view(stored);
    // Nothing is sent anywhere unless the chosen backend is a cloud one that is ready.
    if (stored.backend !== 'cloud' || !current.ready) throw new Error(current.reason ?? CHOOSE);
    const where = target(stored);
    if ('reason' in where) throw new Error(where.reason);
    const mime = typeof raw.mime === 'string' && MIME.test(raw.mime) ? raw.mime : '';
    if (!mime) throw new Error('The recording is not in an audio format Muster can send.');
    if (typeof raw.audio !== 'string' || !raw.audio || raw.audio.length > Math.ceil(DICTATION_MAX_AUDIO_BYTES / 3) * 4 + 4) throw new Error('The recording is empty or too long to transcribe.');
    const audio = Buffer.from(raw.audio, 'base64');
    if (!audio.byteLength || audio.byteLength > DICTATION_MAX_AUDIO_BYTES) throw new Error('The recording is empty or too long to transcribe.');
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime.split(';')[0]! }), `dictation.${extension(mime)}`);
    form.append('model', stored.model);
    form.append('response_format', 'json');
    audio.fill(0);
    const controller = new AbortController();
    inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await request(`${where.endpoint}/audio/transcriptions`, { method: 'POST', body: form, redirect: 'error', signal: controller.signal, headers: where.key ? { Authorization: `Bearer ${where.key}` } : {} });
      } catch { throw new Error(controller.signal.aborted ? 'The transcription service took too long to answer.' : 'Could not reach the transcription service. Check the endpoint and your connection.'); }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(failure(response.status)); }
      let body = '', bytes = 0;
      const reader = response.body?.getReader(), decoder = new TextDecoder();
      if (reader) try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_ANSWER_BYTES) throw new Error('The transcription service sent an answer that is too large.'); body += decoder.decode(value, { stream: true }); }
        body += decoder.decode();
      } finally { await reader.cancel().catch(() => undefined); }
      let text: unknown;
      try { text = (JSON.parse(body) as { text?: unknown })?.text; } catch { text = /^\s*[{[]/.test(body) ? undefined : body; }
      if (typeof text !== 'string') throw new Error('The transcription service did not return any text.');
      return { text: text.trim() };
    } finally { clearTimeout(timer); inflight.delete(controller); }
  };
  return {
    dispose: () => { for (const controller of inflight) controller.abort(); inflight.clear(); },
    handlers: {
      'dictation.config.get': () => view(),
      'dictation.config.set': input => set(input),
      'dictation.transcribe': input => transcribe(input),
      // The desktop app answers this in the main process (it can ask macOS); a browser host asks in the page itself.
      'dictation.microphone': (): MicrophoneAccess => ({ granted: true, status: 'unknown' }),
    },
  };
}
