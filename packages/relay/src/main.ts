/** `npm start` in packages/relay: a local dev relay for pairing a development build of the phone app (#326). */
import {startRelay} from './relay.ts';

const port = Number(process.env.MUSTER_RELAY_PORT ?? 7480);
const host = process.env.MUSTER_RELAY_HOST ?? '127.0.0.1';
const relay = await startRelay({host, port, log: line => console.log(`[relay] ${line}`)});
console.log(`[relay] listening on ${relay.url} (development only; set this address in Settings › Integrations › Phone)`);
const stop = () => { void relay.close().then(() => process.exit(0)); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
