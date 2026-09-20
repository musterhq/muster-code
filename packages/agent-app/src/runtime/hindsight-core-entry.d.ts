declare module '#muster-core/hindsight' {
  export interface MemoryScope { readonly kind: string; readonly id: string }
  export interface HindsightConfig {
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
    readonly maxRequestBytes: number;
  }
  export interface HindsightScopeAuthorization {
    readonly scope: MemoryScope;
    readonly allowedScopes: readonly MemoryScope[];
    readonly allowGlobal?: boolean;
  }
  export interface HindsightRetainItem { readonly content: string; readonly timestamp?: string; readonly context?: string; readonly documentId?: string; readonly tags?: readonly string[]; readonly metadata?: Record<string, string> }
  export interface HindsightRetainInput extends HindsightScopeAuthorization { readonly items: readonly HindsightRetainItem[]; readonly provenance: readonly string[]; readonly async?: boolean; readonly operationId?: string; readonly signal?: AbortSignal }
  export interface HindsightRecallInput extends HindsightScopeAuthorization { readonly query: string; readonly types?: readonly ('world'|'experience'|'observation')[]; readonly budget?: 'low'|'mid'|'high'; readonly maxTokens?: number; readonly tags?: readonly string[]; readonly signal?: AbortSignal }
  export interface HindsightReflectInput extends HindsightScopeAuthorization { readonly query: string; readonly context?: string; readonly budget?: 'low'|'mid'|'high'; readonly maxTokens?: number; readonly signal?: AbortSignal }
  export interface HindsightRetainResult { readonly bankId: string; readonly success: boolean; readonly itemsCount: number; readonly isAsync: boolean; readonly operationId?: string }
  export interface HindsightRecallResult { readonly bankId: string; readonly results: readonly { readonly id?: string; readonly text: string; readonly type?: string; readonly score?: number }[] }
  export interface HindsightReflectResult { readonly bankId: string; readonly text: string }
  export class HindsightClient {
    constructor(config: HindsightConfig);
    retain(input: HindsightRetainInput): Promise<HindsightRetainResult>;
    recall(input: HindsightRecallInput): Promise<HindsightRecallResult>;
    reflect(input: HindsightReflectInput): Promise<HindsightReflectResult>;
  }
  export class HindsightConfigError extends Error {}
  export function resolveHindsightConfig(env?: Record<string, string | undefined>): HindsightConfig;
  export function hindsightBankId(scope: MemoryScope): string;
}
