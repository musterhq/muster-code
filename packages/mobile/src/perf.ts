/** A render counter for performance tests (MUS-SPEC-23-16A): rows report each render to a probe that only tests set. */
export type RenderProbe = (name: string, id: string) => void;
let probe: RenderProbe | null = null;
export const setRenderProbe = (next: RenderProbe | null): void => { probe = next; };
export const reportRender = (name: string, id: string): void => { probe?.(name, id); };
