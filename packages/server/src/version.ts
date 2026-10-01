declare const __MUSTER_SERVER_VERSION__: string | undefined;
/** Injected by scripts/build.mjs from package.json; source runs (tests) read package.json. */
export const VERSION: string = typeof __MUSTER_SERVER_VERSION__ === 'string' ? __MUSTER_SERVER_VERSION__ : '0.0.0-dev';
