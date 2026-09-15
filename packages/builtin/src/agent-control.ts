import type { AgentNode } from "./agent-orchestration.js";

export function childControlRequest(threadId: string, turnId: string, action: "steer" | "interrupt", text?: string): { method: "turn/steer" | "turn/interrupt"; params: Record<string, unknown> } {
  if (!threadId || !turnId) throw new Error("An active child thread and turn ID are required.");
  return action === "interrupt" ? { method: "turn/interrupt", params: { threadId, turnId } } : { method: "turn/steer", params: { threadId, expectedTurnId: turnId, input: [{ type: "text", text: text ?? "" }] } };
}

export function isChildOfRoot(nodes: readonly Pick<AgentNode, "threadId" | "parentThreadId" | "parentId">[], childThreadId: string, rootThreadId: string): boolean {
  if (!childThreadId || !rootThreadId || childThreadId === rootThreadId) return false;
  const byId = new Map(nodes.map((node) => [node.threadId, node])); const seen = new Set<string>(); let current = byId.get(childThreadId);
  while (current && !seen.has(current.threadId)) { seen.add(current.threadId); const parent = current.parentThreadId ?? current.parentId; if (parent === rootThreadId) return true; current = parent ? byId.get(parent) : undefined; }
  return false;
}
