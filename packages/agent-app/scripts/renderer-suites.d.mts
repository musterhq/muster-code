/** Types for renderer-suites.mjs (plain JS so the renderer test runner can import it without a TypeScript step). */
export declare const suites: string[];
export declare const split: Set<string>;
export declare const excluded: Record<string, string>;
export declare function suiteProblems(files: readonly string[], listed?: readonly string[], skipped?: readonly string[]): string[];
export declare const runners: string[];
export declare function discoverRenderer(cwd?: string): {suites: string[]; runners: string[]};
