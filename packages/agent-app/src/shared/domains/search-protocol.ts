/** Search domain contract. Add commands here; the allowlist and service dispatch pick them up. */
export interface SearchCommands {}
export type SearchEvent = never;
export const SEARCH_COMMANDS = {} as const satisfies Record<keyof SearchCommands, true>;
