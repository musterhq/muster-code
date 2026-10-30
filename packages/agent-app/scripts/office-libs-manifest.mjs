// #789: the office libraries agent scripts import (docx, exceljs, pptxgenjs, pdf-lib, jszip, pdfjs-dist) and every
// package they need, read from package-lock.json. The app downloads exactly these tarballs on first use and checks
// each against its lockfile integrity, so agent scripts get the same versions Muster is tested with.
// build.mjs writes the result to dist/runtime/resources/office-libs.json.

/** Packages an agent script may import by name. */
export const OFFICE_LIBRARY_NAMES = ['docx', 'exceljs', 'pptxgenjs', 'pdf-lib', 'jszip', 'pdfjs-dist'];

/** Where a dependency `name` of the package at `from` resolves in the lockfile's node_modules tree (Node's own walk). */
function resolveIn(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const at = base.lastIndexOf('/node_modules/');
    base = at < 0 ? '' : base.slice(0, at);
  }
}

/**
 * The install closure of OFFICE_LIBRARY_NAMES in a package-lock (v2/v3), as `{packages: [{path, name, version, resolved, integrity}]}`
 * sorted by path. Type-only packages (@types/*) and optional native packages are left out: agent scripts never load them.
 */
export function officeLibraryManifest(lock, names = OFFICE_LIBRARY_NAMES) {
  const packages = lock.packages ?? {};
  const seen = new Set();
  const visit = path => {
    if (seen.has(path)) return;
    seen.add(path);
    const entry = packages[path];
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      if (dep.startsWith('@types/')) continue;
      const found = resolveIn(packages, path, dep);
      if (!found) throw new Error(`package-lock.json has no ${dep} for ${path}`);
      visit(found);
    }
  };
  for (const name of names) {
    if (!packages[`node_modules/${name}`]) throw new Error(`package-lock.json has no ${name}`);
    visit(`node_modules/${name}`);
  }
  return {
    packages: [...seen].sort().map(path => {
      const entry = packages[path];
      if (!entry.resolved || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? '')) throw new Error(`${path} has no registry tarball with a sha512 integrity`);
      return {path, name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), version: entry.version, resolved: entry.resolved, integrity: entry.integrity};
    }),
  };
}
