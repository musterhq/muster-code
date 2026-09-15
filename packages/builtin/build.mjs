// Bundle the built-in Muster layer for the VS Code extension host and lay out
// the installable extension directory (dist-ext/) that assemble.sh copies into
// the app bundle. The extension host provides `vscode`; everything else bundles.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";

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
  // The extension host loads built-ins as CJS; muster core is ESM and uses
  // import.meta (node:sqlite via createRequire, path math). Shim it faithfully.
  define: { "import.meta": "__mcImportMeta" },
  banner: { js: "const __mcImportMeta = { url: require(\"node:url\").pathToFileURL(__filename).href, resolve: (s) => require(\"node:url\").pathToFileURL(require.resolve(s)).href };" },
  external: ["vscode", "node:sqlite"],
  sourcemap: true,
  logLevel: "warning",
});

// The browser MCP shim Codex launches over stdio (no vscode import; runs under ELECTRON_RUN_AS_NODE).
await build({ entryPoints: ["src/browser-mcp.ts"], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: `${out}/browser-mcp.js`, logLevel: "warning" });

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
delete manifest.scripts;
delete manifest.devDependencies;
delete manifest.dependencies;
// The VS Code identity is publisher.name → "muster.muster-code" (product.json
// grants + defaultChatAgent key off it); the workspace name stays npm-only.
manifest.name = "muster-code";
manifest.main = "./extension.js";
writeFileSync(`${out}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
cpSync("resources", `${out}/resources`, { recursive: true });
for (const profile of ["openai-direct", "hybrow-gateway"]) chmodSync(`${out}/resources/codex-${profile}.sh`, 0o755);
console.log(`built ${out}/`);
