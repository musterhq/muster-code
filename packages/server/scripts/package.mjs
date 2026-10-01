// Packs the built server into release-dist/muster-server-<version>-<platform>.tar.gz with this machine's Node runtime as bin/node,
// so the tarball runs on a host without Node. Run `npm run build` first (here and in packages/agent-app).
// The store is node:sqlite (built into Node 24): there is no native addon to rebuild per platform; only the Node binary differs.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.join(root, '..', '..');
// Artifacts are named with the Muster Agent version they ship with.
const { version } = JSON.parse(readFileSync(path.join(root, '..', 'agent-app', 'package.json'), 'utf8'));
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) throw new Error(`Package with Node 24 (this is ${process.versions.node}); the bundled runtime targets node24 and node:sqlite.`);
if (!existsSync(path.join(root, 'dist', 'muster-server.cjs'))) throw new Error('Run npm run build first.');
const os = { darwin: 'darwin', linux: 'linux' }[process.platform];
if (!os) throw new Error(`Unsupported platform ${process.platform}.`);
const platform = `${os}-${process.arch}`;
const name = `muster-server-${version}-${platform}`;
const out = path.join(root, 'release-dist');
const stage = path.join(out, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'bin'), { recursive: true });
cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true, filter: src => !src.endsWith('.map') });
copyFileSync(path.join(root, 'bin', 'muster-server'), path.join(stage, 'bin', 'muster-server'));
copyFileSync(process.execPath, path.join(stage, 'bin', 'node'));
chmodSync(path.join(stage, 'bin', 'muster-server'), 0o755); chmodSync(path.join(stage, 'bin', 'node'), 0o755);
copyFileSync(path.join(repo, 'LICENSE'), path.join(stage, 'LICENSE'));
if (existsSync(path.join(repo, 'docs', 'server.md'))) copyFileSync(path.join(repo, 'docs', 'server.md'), path.join(stage, 'README.md'));
writeFileSync(path.join(stage, 'VERSION'), `muster-server ${version} (${platform}, node ${process.versions.node})\n`);
const tarball = path.join(out, `${name}.tar.gz`);
execFileSync('tar', ['-czf', tarball, '-C', out, name]);
rmSync(stage, { recursive: true, force: true });
const sha = createHash('sha256');
await new Promise((resolve, reject) => createReadStream(tarball).on('data', d => sha.update(d)).on('end', resolve).on('error', reject));
console.log(`${sha.digest('hex')}  ${path.basename(tarball)}`);
