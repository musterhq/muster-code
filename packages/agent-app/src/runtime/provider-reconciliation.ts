import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {configuredProviderInstances,type ProviderInstance} from './provider-instances.ts';

export interface ReconciliationInput {threadId: string; turnId: string; cwd: string; providerId?:string; providerBindingId?:string}
export interface ReconciliationResult {resolved: boolean; reason: string; terminalStatus?: 'completed' | 'failed' | 'interrupted'}
export type ProviderStatusQuery = (method: 'thread/read', params: {threadId:string;includeTurns:true}, options: {command:string;cwd:string;timeoutMs:number;env:Record<string,string>}) => Promise<Record<string,unknown>>;

const queryGateway: ProviderStatusQuery = async (method,params,options) => {
  if (!existsSync(options.command)) throw new Error('The selected provider launcher is unavailable.');
  const core = createRequire(__filename)(join(__dirname,'core-client.cjs')) as {queryCodexAppServer?: ProviderStatusQuery};
  if (typeof core.queryCodexAppServer !== 'function') throw new Error('Read-only provider status is unavailable in this build.');
  // Never use callCodexConversation's default-CLI fallback: reconciliation
  // must query the same explicit provider route used to dispatch the attempt.
  return core.queryCodexAppServer(method,params,options);
};

/** One read-only request, with exact persisted identity matching. No retries or prompts. */
export async function reconcileProviderTurn(input: ReconciliationInput, query: ProviderStatusQuery = queryGateway, runtimeDirectory?: string, instances?:ProviderInstance[]): Promise<ReconciliationResult> {
  if (!input.threadId || !input.turnId) return {resolved:false,reason:'Muster did not receive a complete provider thread and turn identity. Automatic verification is unavailable; inspect the existing provider work before continuing.'};
  try {
    const route=(instances??configuredProviderInstances({directory:runtimeDirectory})).find(instance=>instance.info.id===(input.providerId??'hybrow'));
    if(!route?.info.available || !input.providerBindingId || route.info.bindingId!==input.providerBindingId) return {resolved:false,reason:'The saved provider account or profile binding is unavailable or has changed. Restore that binding before verifying this attempt; no alternate provider was queried.'};
    const response = await query('thread/read',{threadId:input.threadId,includeTurns:true},{
      command:route.command,cwd:input.cwd,timeoutMs:5000,
      env:route.env,
    });
    const thread = response.thread as {id?:unknown;turns?:unknown} | undefined;
    if (!thread || thread.id !== input.threadId || !Array.isArray(thread.turns)) return {resolved:false,reason:'The provider did not return the saved thread and its turns. This attempt remains unresolved.'};
    const matches = thread.turns.filter((turn:unknown) => !!turn && typeof turn === 'object' && (turn as {id?:unknown}).id === input.turnId);
    if (matches.length !== 1) return {resolved:false,reason:'The saved turn could not be identified uniquely in the provider response. This attempt remains unresolved.'};
    const status: unknown = matches[0].status;
    if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') return {resolved:false,reason:'The saved turn is still active or its final status is unknown. Wait and check again.'};
    return {resolved:true,terminalStatus:status,reason:`The provider confirms the saved turn is ${status}. You can send a new message; no previous message was resent.`};
  } catch {
    return {resolved:false,reason:'The selected provider status could not be read. Check its availability and try again; this attempt remains unresolved.'};
  }
}
