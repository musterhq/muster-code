import type { DomainContext, DomainModule } from './types.ts';

/** Search domain. Handlers are keyed by the command names in shared/domains/search-protocol.ts. */
export function createSearchDomain(_context: DomainContext): DomainModule {
  return { handlers: {} };
}
