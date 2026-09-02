// Merge the Muster product overlay into the base product.json in place.
// Objects merge one level deep; everything else is replaced by the overlay.
import { readFileSync, writeFileSync } from "node:fs";

const [target, overlayPath] = process.argv.slice(2);
if (!target || !overlayPath) {
  console.error("usage: overlay-product.mjs <product.json> <overlay.json>");
  process.exit(2);
}
const base = JSON.parse(readFileSync(target, "utf8"));
const overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
for (const [key, value] of Object.entries(overlay)) {
  const current = base[key];
  base[key] = value && typeof value === "object" && !Array.isArray(value) && current && typeof current === "object" && !Array.isArray(current)
    ? { ...current, ...value }
    : value;
}
writeFileSync(target, `${JSON.stringify(base, null, 2)}\n`);
console.log(`  product.json ← ${Object.keys(overlay).length} keys`);
