import { isChildOfRoot } from "./agent-control.js";

export interface LeaseNode { threadId: string; parentThreadId?: string; parentId?: string; status: string }

export function activeDescendantCount(nodes: readonly LeaseNode[], rootThreadId: string): number {
  return nodes.filter((node) => isChildOfRoot(nodes, node.threadId, rootThreadId) && (node.status === "pendingInit" || node.status === "running")).length;
}

export function editLeaseActive(parentRunning: boolean, nodes: readonly LeaseNode[], rootThreadId?: string): boolean {
  return parentRunning || (!!rootThreadId && activeDescendantCount(nodes, rootThreadId) > 0);
}

export function canCloseWithActiveDescendants(nodes: readonly LeaseNode[], rootThreadId: string): boolean { return activeDescendantCount(nodes, rootThreadId) === 0; }
