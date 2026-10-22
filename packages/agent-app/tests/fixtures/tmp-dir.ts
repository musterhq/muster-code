import {rm} from 'node:fs/promises';

export function removeTmp(dir: string) { return rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); }
