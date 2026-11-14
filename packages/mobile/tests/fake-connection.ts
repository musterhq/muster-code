/** A MobileConnection double for screen tests: records calls, answers from a table and lets a test emit events. */
import type {MobileAccess, MobileConnection, MobileEvent, MobileMethod} from '../src/shared';

export interface FakeConnection extends MobileConnection {
  calls: Array<{method: MobileMethod; params: unknown}>;
  emit(event: MobileEvent): void;
  setAccess(access: MobileAccess): void;
}
export function fakeConnection(answers: Partial<Record<MobileMethod, unknown | ((params: any) => unknown)>>, access: MobileAccess = 'act'): FakeConnection {
  const listeners = new Set<(event: MobileEvent) => void>();
  const fake: FakeConnection = {
    desktopName: 'Studio Mac', deviceId: 'device-1', access, closed: false, via: 'relay', lan: [], calls: [],
    async call(method, params) {
      fake.calls.push({method, params});
      const answer = answers[method];
      return (typeof answer === 'function' ? (answer as (p: unknown) => unknown)(params) : answer ?? {}) as never;
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onClose() { return () => undefined; },
    close() {},
    emit(event) { if (event.type === 'access') (fake as {access: MobileAccess}).access = event.access; for (const listener of [...listeners]) listener(event); },
    setAccess(next) { (fake as {access: MobileAccess}).access = next; },
  };
  return fake;
}

/** Lays the chat's list out as a phone would (a 390 × 800 window): the virtualized list mounts rows only once measured. */
export async function layOutTimeline(testID = 'chat-timeline'): Promise<void> {
  const {act, fireEvent, screen} = require('@testing-library/react-native') as typeof import('@testing-library/react-native');
  await act(async () => { fireEvent(screen.getByTestId(testID), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 800}}}); });
  // The list reveals its rows a frame after it is measured.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}
/** Measures every row the list mounted (a device does this on its own), so the rows show and take presses. */
export async function layOutRows(testID = 'chat-timeline'): Promise<void> {
  const {act, fireEvent, screen} = require('@testing-library/react-native') as typeof import('@testing-library/react-native');
  const list = screen.getByTestId(testID);
  const rows = list.queryAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function' && node !== list);
  await act(async () => { for (const row of rows) fireEvent(row, 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 390, height: 56}}}); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}
