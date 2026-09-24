/** Clone sheet destination helpers (pure: no bridge, no DOM). */
const separator = (path: string) => path.includes('\\') && !path.includes('/') ? '\\' : '/';
/** The folder containing `path` (so the picker opens where the repository folder would go). */
export function parentFolder(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at > 0 ? trimmed.slice(0, at) : trimmed || path;
}
/** `<parent>/<repo>` for a picked parent: the runtime names it (and steps past an existing `<repo>`), else the
 *  current destination's folder name, else `repository`. */
export async function destinationInParent(parent: string, url: string, current: string, resolveName: (input: {url: string; parent: string}) => Promise<{path: string}>): Promise<string> {
  if (url) { try { return (await resolveName({url, parent})).path; } catch { /* not a valid URL yet: fall back */ } }
  const name = current.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repository';
  return `${parent.replace(/[\\/]+$/, '')}${separator(parent)}${name}`;
}
