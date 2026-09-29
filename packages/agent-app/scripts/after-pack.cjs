// electron-builder afterPack: on Linux, swap the Electron binary for the sandbox-aware launcher
// (resources/linux/muster-agent.sh) so AppImage, deb and tar.gz start correctly where user namespaces are restricted.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const real = path.join(context.appOutDir, name);
  if (!fs.existsSync(real)) throw new Error(`afterPack: ${real} not found`);
  fs.renameSync(real, `${real}.bin`);
  fs.copyFileSync(path.join(__dirname, '..', 'resources', 'linux', 'muster-agent.sh'), real);
  fs.chmodSync(real, 0o755);
};
