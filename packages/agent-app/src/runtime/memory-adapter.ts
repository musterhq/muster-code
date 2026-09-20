import { createRequire } from 'node:module';
import { join } from 'node:path';

/** The core engine is emitted as core-memory.cjs beside service.cjs. */
export interface MemoryScope { kind: string; id: string }
export interface MemoryEntry {
  id: string; kind: string; summary: string; sourceUri?: string; observedAt: string;
  confidence: number; provenance: string[]; scopes: MemoryScope[];
  redactionState: 'none' | 'redacted' | 'hashed' | 'blocked'; links?: string[];
}
interface CoreMemory {
  addMemory(input: { kind?: string; summary: string; provenance: string[]; scopes: MemoryScope[]; explicitUserRequest?: boolean }, cwd?: string): Promise<MemoryEntry>;
  listMemory(cwd?: string): Promise<MemoryEntry[]>;
  searchMemory(input: { query?: string; scopes: MemoryScope[]; limit?: number; match?: 'all' | 'any' }, cwd?: string): Promise<MemoryEntry[]>;
  inspectMemoryStore(cwd?: string): Promise<{ jsonl: { objectCount: number }; checks: Array<{ label: string; status: string; detail: string }> }>;
  isVisibleInScopes(object: MemoryEntry, scopes: readonly MemoryScope[]): boolean;
}
let core: CoreMemory | undefined;
function engine(): CoreMemory {
  return core ??= createRequire(__filename)(join(__dirname, 'core-memory.cjs')) as CoreMemory;
}
export const addMemory: CoreMemory['addMemory'] = (...args) => engine().addMemory(...args);
export const listMemory: CoreMemory['listMemory'] = (...args) => engine().listMemory(...args);
export const searchMemory: CoreMemory['searchMemory'] = (...args) => engine().searchMemory(...args);
export const inspectMemoryStore: CoreMemory['inspectMemoryStore'] = (...args) => engine().inspectMemoryStore(...args);
export const isVisibleInScopes: CoreMemory['isVisibleInScopes'] = (...args) => engine().isVisibleInScopes(...args);
