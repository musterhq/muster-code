/**
 * Keyboard model for the changed-files list and the Diff tab (DIF-06):
 * ArrowUp/ArrowDown (or k/j) move between file rows, Home/End jump, and in a
 * Diff tab Alt+ArrowUp/Alt+ArrowDown (or [ / ]) open the previous/next file.
 * Pure so it can be tested without a DOM; callers map the result to focus/open.
 */
export function nextChangeIndex(current: number, count: number, key: string): number | undefined {
  if (count <= 0) return undefined;
  const last = count - 1;
  const at = current < 0 ? -1 : Math.min(current, last);
  switch (key) {
    case 'ArrowDown': case 'j': return at < last ? at + 1 : at < 0 ? 0 : undefined;
    case 'ArrowUp': case 'k': return at > 0 ? at - 1 : at < 0 ? last : undefined;
    case 'Home': return at === 0 ? undefined : 0;
    case 'End': return at === last ? undefined : last;
    default: return undefined;
  }
}

/** Diff tab: which sibling file a shortcut opens, or undefined for keys that are not file navigation. */
export function diffFileStep(event: {key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean}, inField: boolean): -1 | 1 | undefined {
  if (event.metaKey || event.ctrlKey) return undefined;
  if (event.altKey && event.key === 'ArrowDown') return 1;
  if (event.altKey && event.key === 'ArrowUp') return -1;
  if (inField || event.altKey) return undefined;
  if (event.key === ']') return 1;
  if (event.key === '[') return -1;
  return undefined;
}

export const isEditableTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable === true;
};
