/** "New project" from outside the Projects screen: open it straight into the create form. */
let pending = false;
const EVENT = 'muster:new-project';

export function requestNewProject(open: () => void): void {
  pending = true;
  open();
  window.dispatchEvent(new Event(EVENT));
}

/** True once per request; the Projects screen reads it on mount and on the event. */
export function takeNewProjectRequest(): boolean {
  const value = pending;
  pending = false;
  return value;
}

export function onNewProjectRequest(listener: () => void): () => void {
  const handler = () => { if (takeNewProjectRequest()) listener(); };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
