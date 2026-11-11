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
