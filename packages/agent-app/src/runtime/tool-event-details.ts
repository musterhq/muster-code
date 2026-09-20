/** Bounded, explicit provider metadata. Shell text is never parsed into actions. */
export function toolEventDetails(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['outputSource','type','command','cwd','title','name','path','query','server','tool','namespace','prompt','model','senderThreadId']) {
    if (typeof item[key] === 'string') result[key] = item[key].slice(0, 32768);
  }
  for (const key of ['durationMs','exitCode']) if (typeof item[key] === 'number' && Number.isFinite(item[key]) && (key === 'exitCode' || item[key] >= 0)) result[key] = item[key];
  for (const key of ['agentNickname', 'agentRole']) {
    if (typeof item[key] === 'string') result[key] = item[key].slice(0, 256);
  }
  if (Array.isArray(item.commandActions)) result.commandActions = item.commandActions.slice(0,256).filter(isObject).map(action=>pick(action,['outputSource','type','command','path','name','query']));
  if (Array.isArray(item.changes)) result.changes = item.changes.slice(0,256).filter(isObject).map(change=>pick(change,['path','diff','kind']));
  if (Array.isArray(item.receiverThreadIds)) result.receiverThreadIds = item.receiverThreadIds.filter((v):v is string=>typeof v==='string').slice(0,256).map(v=>v.slice(0,256));
  for (const key of ['arguments','result','error','agentsStates','receiverAgents','contentItems','appContext']) {
    if (item[key] != null) {
      try { const json = JSON.stringify(item[key]); result[key] = json.length <= 32768 ? json : json.slice(0,32768)+'\n[Details truncated]'; } catch {}
    }
  }
  return result;
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value==='object' && !Array.isArray(value); }
function pick(value:Record<string,unknown>,keys:string[]):Record<string,unknown> {
  return Object.fromEntries(keys.flatMap(key=>typeof value[key]==='string'?[[key,value[key].slice(0,32768)]]:[]));
}
