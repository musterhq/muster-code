import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  HindsightClient,
  HindsightConfig,
  HindsightRecallResult,
  HindsightReflectResult,
  HindsightRetainResult,
  MemoryScope,
} from '#muster-core/hindsight';

const URL_ENV = 'HINDSIGHT_API_URL';
const KEY_ENV = 'HINDSIGHT_API_KEY';
const MAX_CONTENT = 32_768;
const MAX_QUERY = 8_192;
const MAX_CONTEXT = 32_768;
const MAX_PROVENANCE = 16;
const MAX_PROVENANCE_ENTRY = 512;
const MAX_ITEMS = 64;
const MAX_TOKENS = 16_384;
const MAX_TYPES = 8;

function loadCore(): HindsightCoreModule {
  try {
    // Keep require inside the lazy loader: the runtime service is bundled as
    // CommonJS, where import.meta is unavailable. Tests inject `core`.
    const require = createRequire(__filename);
    return require(join(__dirname, 'core-hindsight.cjs')) as HindsightCoreModule;
  } catch {
    throw new HindsightUnavailableError('Hindsight core is unavailable in this build.');
  }
}

export interface HindsightStatus {
  readonly configured: boolean;
  readonly endpoint?: string;
  readonly bankId?: string;
  readonly error?: string;
  readonly revision?: number;
  readonly connection?: 'unchecked' | 'verified' | 'failed';
  readonly checkedAt?: string;
  readonly connectionError?: string;
}

export interface HindsightRetainItem {
  readonly content: string;
  readonly timestamp?: string;
  readonly context?: string;
  readonly documentId?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface HindsightRetainInput {
  readonly folderId: string;
  readonly items: readonly HindsightRetainItem[];
  readonly provenance: readonly string[];
  readonly async?: boolean;
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

export interface HindsightRecallInput {
  readonly folderId: string;
  readonly query: string;
  readonly types?: readonly ('world' | 'experience' | 'observation')[];
  readonly budget?: 'low' | 'mid' | 'high';
  readonly maxTokens?: number;
  readonly tags?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface HindsightReflectInput {
  readonly folderId: string;
  readonly query: string;
  readonly context?: string;
  readonly budget?: 'low' | 'mid' | 'high';
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface HindsightScopeResolver {
  /** Resolves a trusted runtime folder identity; renderer-supplied scopes are not accepted. */
  (folderId: string): MemoryScope | undefined | Promise<MemoryScope | undefined>;
}

export interface HindsightClientLike {
  retain(input: Parameters<HindsightClient['retain']>[0]): Promise<HindsightRetainResult>;
  recall(input: Parameters<HindsightClient['recall']>[0]): Promise<HindsightRecallResult>;
  reflect(input: Parameters<HindsightClient['reflect']>[0]): Promise<HindsightReflectResult>;
}

interface HindsightCoreModule {
  readonly HindsightClient: new (config: HindsightConfig) => HindsightClientLike;
  readonly HindsightConfigError: new (...args: never[]) => Error;
  readonly resolveHindsightConfig: (env?: Record<string, string | undefined>) => HindsightConfig;
  readonly hindsightBankId: (scope: MemoryScope) => string;
}

export interface HindsightServiceOptions {
  readonly env?: Record<string, string | undefined>;
  readonly resolveFolderScope: HindsightScopeResolver;
  readonly createClient?: (config: HindsightConfig) => HindsightClientLike;
  /** Test seam; production loads the bundled core-hindsight.cjs boundary. */
  readonly core?: HindsightCoreModule;
}

export class HindsightUnavailableError extends Error {}
export class HindsightInputError extends Error {}

function boundedString(value: string, field: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (required && !value.trim())) {
    throw new HindsightInputError(`${field} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function boundedTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TOKENS) throw new HindsightInputError(`maxTokens must be a positive integer <= ${MAX_TOKENS}.`);
  return value;
}

function budget(value: HindsightRecallInput['budget'] | HindsightReflectInput['budget']): HindsightRecallInput['budget'] | undefined {
  if (value === undefined) return undefined;
  if (value !== 'low' && value !== 'mid' && value !== 'high') throw new HindsightInputError('budget must be low, mid, or high.');
  return value;
}

function boundedTags(tags: readonly string[] | undefined): readonly string[] | undefined {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags) || tags.length > 32) throw new HindsightInputError('tags must contain at most 32 entries.');
  return tags.map((tag) => boundedString(tag, 'tag', 128));
}

function boundedMetadata(metadata: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined {
  if (metadata === undefined) return undefined;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new HindsightInputError('metadata must be an object.');
  const prototype = Object.getPrototypeOf(metadata);
  if (prototype !== Object.prototype && prototype !== null) throw new HindsightInputError('metadata must be a plain object.');
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const entries = Object.entries(metadata);
  if (entries.length > 32) throw new HindsightInputError('metadata must contain at most 32 entries.');
  for (const [key, value] of entries) {
    result[boundedString(key, 'metadata key', 128)] = boundedString(value, 'metadata value', 512, false);
  }
  return result;
}

function scopeAuth(scope: MemoryScope) {
  if (!scope || typeof scope.id !== 'string' || !scope.id.trim() || typeof scope.kind !== 'string' || !scope.kind.trim()) throw new HindsightInputError('Resolved folder scope is invalid.');
  return { scope, allowedScopes: [scope] as const };
}

interface ClientGeneration {
  readonly config: HindsightConfig;
  readonly client: HindsightClientLike;
  readonly revision: number;
  readonly banks: Map<string, Pick<HindsightStatus, 'connection' | 'checkedAt' | 'connectionError'>>;
  readonly latest: Map<string, number>;
}

interface ResolvedRequest { scope: MemoryScope; client: HindsightClientLike; generation: ClientGeneration }

export class HindsightService {
  private readonly core: HindsightCoreModule;
  private current?: ClientGeneration;
  private revision = 0;
  private operationSequence = 0;
  private configurationError?: string;
  private disposed = false;
  private readonly active = new Set<AbortController>();

  constructor(private readonly options: HindsightServiceOptions) {
    this.core = options.core ?? loadCore();
    this.refreshConfiguration();
  }

  private refreshConfiguration(): void {
    if (this.disposed) return;
    const env = this.options.env ?? process.env;
    try {
      const config = this.core.resolveHindsightConfig({ [URL_ENV]: env[URL_ENV], [KEY_ENV]: env[KEY_ENV] });
      const endpoint = new URL(config.baseUrl);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid base URL.');
      if (this.current?.config.baseUrl === config.baseUrl && this.current.config.apiKey === config.apiKey) return;
      const client = (this.options.createClient ?? ((next) => new this.core.HindsightClient(next)))(config);
      // Existing operations retain their captured client. A refresh changes only
      // future operations, and old completions cannot verify the new endpoint.
      this.current = { config, client, revision: ++this.revision, banks: new Map(), latest: new Map() };
      this.configurationError = undefined;
    } catch {
      if (this.current) this.revision++;
      this.current = undefined;
      // Config errors can contain the supplied URL/key; never forward them.
      this.configurationError = env[URL_ENV]
        ? 'Hindsight configuration is invalid or unavailable. Check its service base URL and API key environment variables.'
        : 'Hindsight is not configured. Set HINDSIGHT_API_URL for Muster.';
    }
  }

  status(folderId: string): HindsightStatus {
    if (this.disposed) return { configured: false, connection: 'unchecked', error: 'Hindsight service is disposed.' };
    // The existing status command is also the panel's explicit config refresh.
    // This reads process configuration only; it never sends a probe or memory.
    this.refreshConfiguration();
    const current = this.current;
    if (!current) return { configured: false, revision: this.revision, connection: 'unchecked', error: this.configurationError ?? 'Hindsight is unavailable.' };
    const base = { configured: true, endpoint: current.config.baseUrl, revision: current.revision, connection: 'unchecked' as const };
    try {
      const scope = this.options.resolveFolderScope(folderId);
      if (scope instanceof Promise) { void scope.catch(() => {}); return { ...base, error: 'Scope resolution is asynchronous; use an operation to resolve it.' }; }
      if (!scope) return { ...base, error: 'Folder scope is unavailable.' };
      const bankId = this.core.hindsightBankId(scopeAuth(scope).scope);
      return { ...base, bankId, ...current.banks.get(bankId) };
    } catch {
      return { ...base, error: 'Folder scope is unavailable.' };
    }
  }

  private async resolve(folderId: string): Promise<ResolvedRequest> {
    if (this.disposed) throw new HindsightUnavailableError('Hindsight service is disposed.');
    const generation = this.current;
    if (!generation) throw new HindsightUnavailableError(this.configurationError ?? 'Hindsight is not configured.');
    const scope = await this.options.resolveFolderScope(boundedString(folderId, 'folderId', 128));
    if (!scope) throw new HindsightUnavailableError('Hindsight is unavailable for this folder: its trusted scope could not be resolved.');
    scopeAuth(scope);
    return { scope: { kind: scope.kind, id: scope.id }, client: generation.client, generation };
  }

  private async call<T>(request: ResolvedRequest, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new HindsightUnavailableError('Hindsight service is disposed.');
    const bankId = this.core.hindsightBankId(request.scope);
    const controller = new AbortController();
    this.active.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const sequence = ++this.operationSequence;
    request.generation.latest.set(bankId, sequence);
    const record = (connection: 'verified' | 'failed') => {
      if (this.disposed || combined.aborted || this.current !== request.generation || request.generation.latest.get(bankId) !== sequence) return;
      request.generation.banks.set(bankId, { connection, checkedAt: new Date().toISOString(), ...(connection === 'failed' ? { connectionError: 'The last request failed. Check the service and its credentials, then retry when ready.' } : {}) });
    };
    try { const result = await operation(combined); record('verified'); return result; }
    catch {
      record('failed');
      // Provider errors may contain response bodies or credential-bearing URLs.
      // Both the status payload and the operation error cross into the renderer.
      throw new HindsightUnavailableError(combined.aborted
        ? 'Hindsight request aborted.'
        : 'Hindsight request failed. Check the service and its credentials.');
    }
    finally { this.active.delete(controller); }
  }

  async retain(input: HindsightRetainInput): Promise<HindsightRetainResult> {
    const request = await this.resolve(input.folderId);
    const { scope, client } = request;
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_ITEMS) throw new HindsightInputError(`items must contain 1-${MAX_ITEMS} entries.`);
    if (!Array.isArray(input.provenance) || input.provenance.length === 0 || input.provenance.length > MAX_PROVENANCE) throw new HindsightInputError(`provenance must contain 1-${MAX_PROVENANCE} entries.`);
    const provenance = input.provenance.map((value) => boundedString(value, 'provenance', MAX_PROVENANCE_ENTRY));
    const items = input.items.map((item) => {
      if (!item || typeof item !== 'object') throw new HindsightInputError('Each retain item must be an object.');
      if (item.tags !== undefined) boundedTags(item.tags);
      if (item.timestamp !== undefined) boundedString(item.timestamp, 'timestamp', 128);
      if (item.documentId !== undefined) boundedString(item.documentId, 'documentId', 256);
      const metadata = boundedMetadata(item.metadata);
      return { ...item, content: boundedString(item.content, 'content', MAX_CONTENT), ...(item.context === undefined ? {} : { context: boundedString(item.context, 'context', MAX_CONTEXT, false) }), ...(metadata ? { metadata } : {}) };
    });
    // One call, no retry: retain is a side effect and operationId is the only
    // supported deduplication mechanism exposed by the core client.
    if (input.async !== undefined && typeof input.async !== 'boolean') throw new HindsightInputError('async must be boolean.');
    const operationId = input.operationId === undefined ? undefined : boundedString(input.operationId, 'operationId', 128);
    return this.call(request, input.signal, (signal) => client.retain({ ...scopeAuth(scope), items, provenance, async: input.async, operationId, signal }));
  }

  async recall(input: HindsightRecallInput): Promise<HindsightRecallResult> {
    const request = await this.resolve(input.folderId);
    const { scope, client } = request;
    const query = boundedString(input.query, 'query', MAX_QUERY);
    const maxTokens = boundedTokens(input.maxTokens);
    if (input.types !== undefined && (!Array.isArray(input.types) || input.types.length > MAX_TYPES)) throw new HindsightInputError(`types must contain at most ${MAX_TYPES} entries.`);
    const types = input.types === undefined ? undefined : input.types.map((type) => {
      if (type !== 'world' && type !== 'experience' && type !== 'observation') throw new HindsightInputError('types contains an invalid memory type.');
      return type;
    });
    const tags = boundedTags(input.tags);
    const selectedBudget = budget(input.budget);
    return this.call(request, input.signal, (signal) => client.recall({ ...scopeAuth(scope), query, types, budget: selectedBudget, maxTokens, tags, signal }));
  }

  async reflect(input: HindsightReflectInput): Promise<HindsightReflectResult> {
    const request = await this.resolve(input.folderId);
    const { scope, client } = request;
    const query = boundedString(input.query, 'query', MAX_QUERY);
    const maxTokens = boundedTokens(input.maxTokens);
    const context = input.context === undefined ? undefined : boundedString(input.context, 'context', MAX_CONTEXT, false);
    const selectedBudget = budget(input.budget);
    return this.call(request, input.signal, (signal) => client.reflect({ ...scopeAuth(scope), query, context, budget: selectedBudget, maxTokens, signal }));
  }

  dispose(): void { this.disposed = true; for (const controller of this.active) controller.abort(); this.active.clear(); }
}
