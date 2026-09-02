// Bundle the built-in Muster layer for the VS Code extension host and lay out
// the installable extension directory (dist-ext/) that assemble.sh copies into
// the app bundle. The extension host provides `vscode`; everything else bundles.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";

const out = "dist-ext";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: `${out}/extension.js`,
  external: ["vscode", "node:sqlite"],
  sourcemap: true,
  logLevel: "warning",
});

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
delete manifest.scripts;
delete manifest.devDependencies;
delete manifest.dependencies;
writeFileSync(`${out}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
cpSync("resources", `${out}/resources`, { recursive: true });
console.log(`built ${out}/`);
