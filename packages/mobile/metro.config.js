// The phone link's protocol and Noise code is shared with the desktop app (packages/agent-app/src/shared/mobile), so Metro
// watches that folder too. Nothing else from the desktop app is bundled.
const path = require('node:path');
const {getDefaultConfig} = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../agent-app/src/shared/mobile')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
module.exports = config;
