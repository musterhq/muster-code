/** Files recently opened in the file viewer (#326 phase 6), per computer and chat, newest first. Kept for this run of the app:
 *  the files screen's Recent segment and its cards read it. */
const MAX = 12;
const lists = new Map<string, Array<{path: string; at: string}>>();
export const recentScope = (deviceId: string, chatId: string) => `${deviceId}:${chatId}`;
export function noteOpened(scope: string, path: string): void {
  const list = (lists.get(scope) ?? []).filter(entry => entry.path !== path);
  list.unshift({path, at: new Date().toISOString()});
  lists.set(scope, list.slice(0, MAX));
}
export const recentFiles = (scope: string): ReadonlyArray<{path: string; at: string}> => lists.get(scope) ?? [];
