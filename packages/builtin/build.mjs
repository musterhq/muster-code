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
  format: "esm",
  target: "node22",
  outfile: `${out}/extension.js`,
  banner: { js: "import { createRequire as __mcCreateRequire } from \"node:module\"; const require = __mcCreateRequire(import.meta.url);" },
  external: ["vscode", "node:sqlite"],
  sourcemap: true,
  logLevel: "warning",
});

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
delete manifest.scripts;
delete manifest.devDependencies;
delete manifest.dependencies;
manifest.type = "module";
// The VS Code identity is publisher.name → "muster.muster-code" (product.json
// grants + defaultChatAgent key off it); the workspace name stays npm-only.
manifest.name = "muster-code";
manifest.main = "./extension.js";
writeFileSync(`${out}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
cpSync("resources", `${out}/resources`, { recursive: true });
console.log(`built ${out}/`);
