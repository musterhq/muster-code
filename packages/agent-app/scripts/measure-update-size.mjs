#!/usr/bin/env node
// What an in-place update from one build to the next downloads (#317): compares the block maps of two AppImages
// (embedded) or two setup.exe files (<file>.blockmap) with the same planner the app uses (src/main/update-differential.ts).
//   node --experimental-transform-types scripts/measure-update-size.mjs <old file or dir> <new file or dir> [--max-ratio 0.5]
// Prints the sizes (and adds them to the GitHub job summary); fails above --max-ratio of the full file.
import {appendFileSync, existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {parseBlockMap, planDifferential, readEmbeddedBlockMap} from '../src/main/update-differential.ts';

const [oldArg, newArg] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const maxIndex = process.argv.indexOf('--max-ratio');
const maxRatio = maxIndex > 0 ? Number(process.argv[maxIndex + 1]) : 0.5;
if (!oldArg || !newArg) { console.error('usage: measure-update-size.mjs <old> <new> [--max-ratio 0.5]'); process.exit(2); }

const pick = target => {
  if (!statSync(target).isDirectory()) return target;
  const name = readdirSync(target).find(file => /\.AppImage$|-setup\.exe$/.test(file));
  if (!name) throw new Error(`no AppImage or setup.exe in ${target}`);
  return path.join(target, name);
};
const mapOf = async file => {
  if (file.endsWith('.AppImage')) return (await readEmbeddedBlockMap(file)).map;
  if (!existsSync(`${file}.blockmap`)) throw new Error(`${file}.blockmap is missing`);
  return parseBlockMap(readFileSync(`${file}.blockmap`), 'gzip');
};
const MB = bytes => `${(bytes / 1_000_000).toFixed(1)} MB`;

const oldFile = pick(oldArg), newFile = pick(newArg);
const plan = planDifferential(await mapOf(oldFile), await mapOf(newFile));
const full = statSync(newFile).size, ratio = plan.downloadBytes / full;
const lines = [
  `old:  ${path.basename(oldFile)} (${MB(statSync(oldFile).size)})`,
  `new:  ${path.basename(newFile)} (${MB(full)})`,
  `differential download: ${MB(plan.downloadBytes)} in ${plan.requests} range requests (${(ratio * 100).toFixed(1)}% of the full file)`,
];
for (const line of lines) console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Update size\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
if (ratio > maxRatio) { console.error(`UPDATE SIZE FAIL: ${(ratio * 100).toFixed(1)}% is above ${(maxRatio * 100).toFixed(0)}%`); process.exit(1); }
