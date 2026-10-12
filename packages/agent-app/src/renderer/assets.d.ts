declare module '*.css';
declare module '*.wasm' { const bytes: Uint8Array; export default bytes; }
declare module '*.cjs' { const factory: (config: Record<string, unknown>) => unknown; export default factory; }
