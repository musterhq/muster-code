// README screenshot entry: the real renderer, plus a handle on its store so the driver can
// open screens the way the menus do. Only used by scripts/readme-shots/shoot.mjs.
import '../../src/renderer/main.tsx';
import * as store from '../../src/renderer/store';
(window as unknown as {__shots: unknown}).__shots = {store};
