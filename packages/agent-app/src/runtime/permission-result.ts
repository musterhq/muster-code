/** No opinion is useful at the policy boundary, but never grants permission to execute a tool. */
export type PermissionResult = 'allow' | 'deny' | 'no-opinion';
export type RequestResult = PermissionResult | Record<string, unknown> | undefined;

/** Normalize the host's typed answer or a provider protocol reply in one place. Missing and malformed replies fail closed. */
export function permissionResult(answer: RequestResult): PermissionResult {
  if (answer === 'allow' || answer === 'deny' || answer === 'no-opinion') return answer;
  if (!answer || typeof answer !== 'object') return 'deny';
  if (answer.decision === 'accept' || answer.decision === 'acceptForSession') return 'allow';
  if (answer.decision === 'decline' || answer.decision === 'cancel') return 'deny';
  return 'deny';
}

/** Non-permission requests (questions and elicitations) keep their protocol payload. */
export function requestReply(answer: RequestResult, method?: string): Record<string, unknown> | undefined {
  if (method?.endsWith('/requestApproval')) {
    const result = permissionResult(answer);
    if (typeof answer === 'object' && answer !== null && (result === 'allow' || answer.decision === 'decline' || answer.decision === 'cancel')) return answer;
    return {decision: result === 'allow' ? 'accept' : 'decline'};
  }
  if (typeof answer === 'object' && answer !== null) return answer;
  if (answer === undefined) return undefined;
  return {decision: permissionResult(answer) === 'allow' ? 'accept' : 'decline'};
}
