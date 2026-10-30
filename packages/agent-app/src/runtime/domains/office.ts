/**
 * The office domain (#789). Contract: shared/domains/office-protocol.ts.
 * Owns Muster's office runtime (<agent-data>/office-runtime) and hands it to the document preview. A download runs in the
 * background; the Settings row follows it through `officeRuntimeChanged` events.
 */
import { join } from 'node:path';
import type { AgentEvent } from '../../shared/protocol.ts';
import { OfficeRuntime, type OfficeRuntimeOptions } from '../office-runtime.ts';
import { activeOfficeRuntime, setOfficeRuntime } from '../document-preview.ts';
import type { DomainContext, DomainModule } from './types.ts';

/** Tests only: fakes for the network and the unpacker. Unset in the app. */
export const officeRuntimeTesting: { options?: Partial<Omit<OfficeRuntimeOptions, 'root' | 'onProgress'>> } = {};

export function createOfficeDomain(ctx: DomainContext): DomainModule {
  // Events go out in order, so the last one a Settings row sees is the latest state.
  let chain: Promise<void> = Promise.resolve();
  const emitStatus = () => { chain = chain.then(async () => { ctx.emit({ type: 'officeRuntimeChanged', status: await runtime.status() } as AgentEvent); }).catch(() => undefined); return chain; };
  const runtime = new OfficeRuntime({ root: join(ctx.dataDir, 'office-runtime'), ...officeRuntimeTesting.options, onProgress: () => { void emitStatus(); } });
  setOfficeRuntime(runtime);
  return {
    handlers: {
      'office.runtime.status': () => runtime.status(),
      'office.runtime.download': async () => {
        const job = runtime.ensure();
        void job.then(emitStatus, emitStatus);
        await Promise.race([job.then(() => undefined, () => undefined), runtime.whenBusy()]);
        return runtime.status();
      },
      'office.runtime.remove': async () => { await runtime.remove(); await emitStatus(); return runtime.status(); },
    },
    dispose() { if (activeOfficeRuntime() === runtime) setOfficeRuntime(null); },
  };
}
