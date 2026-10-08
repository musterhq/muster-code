// electron-builder afterPack: on Linux, swap the Electron binary for the sandbox-aware launcher
// (resources/linux/muster-agent.sh) so AppImage, deb and tar.gz start correctly where user namespaces are restricted.
const fs = require('node:fs');
const path = require('node:path');

// node-pty ships prebuilds for several platforms; keep only the one being packaged. The loader (node-pty/lib/utils.js) reads
// build/Release first and prebuilds/<platform>-<arch> second, so another platform's directory is never opened.
function pruneForeignPrebuilds(context) {
  const prebuilds = path.join(context.appOutDir, 'resources', 'app', 'node_modules', 'node-pty', 'prebuilds');
  if (!fs.existsSync(prebuilds)) return;
  for (const name of fs.readdirSync(prebuilds)) if (!name.startsWith(`${context.electronPlatformName}-`)) fs.rmSync(path.join(prebuilds, name), {recursive: true, force: true});
  if (fs.readdirSync(prebuilds).length === 0) fs.rmdirSync(prebuilds);
}

exports.default = async function afterPack(context) {
  pruneForeignPrebuilds(context);
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const real = path.join(context.appOutDir, name);
  if (!fs.existsSync(real)) throw new Error(`afterPack: ${real} not found`);
  fs.renameSync(real, `${real}.bin`);
  fs.copyFileSync(path.join(__dirname, '..', 'resources', 'linux', 'muster-agent.sh'), real);
  fs.chmodSync(real, 0o755);
};
