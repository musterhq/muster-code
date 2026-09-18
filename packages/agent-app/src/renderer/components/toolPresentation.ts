/**
 * Pure display classification for provider tool items.
 * Trusts only the explicit event `type` recorded by the runtime; never
 * infers a tool kind from shell text, and never fabricates status.
 */
export type ToolKind = 'read' | 'search' | 'list' | 'command' | 'subagent' | 'mcp' | 'generic';

export interface ToolPresentation {
  kind: ToolKind;
  /** Past-tense verb for settled rows. */
  verb: string;
  /** Present-tense verb while running. */
  runningVerb: string;
  /** Path, query, or tool name straight from event data; '' when absent. */
  subject: string;
}

export function classifyTool(data: Record<string, unknown> | undefined): ToolPresentation {
  const type = typeof data?.type === 'string' ? data.type : '';
  const subject = typeof data?.name === 'string' ? data.name : '';
  switch (type) {
    case 'fileRead': return { kind: 'read', verb: 'Read', runningVerb: 'Reading', subject };
    case 'webSearch': return { kind: 'search', verb: 'Searched', runningVerb: 'Searching', subject };
    case 'todoList': return { kind: 'list', verb: 'Listed to-dos', runningVerb: 'Listing to-dos', subject };
    case 'commandExecution': return { kind: 'command', verb: 'Ran', runningVerb: 'Running', subject };
    case 'collabAgentToolCall': return { kind: 'subagent', verb: 'Delegated', runningVerb: 'Delegating', subject };
    case 'mcpToolCall': return { kind: 'mcp', verb: 'Called', runningVerb: 'Calling', subject };
    default: return { kind: 'generic', verb: 'Ran tool', runningVerb: 'Running tool', subject };
  }
}

/** Display-only normalization for terminal cards. The original command remains available expanded. */
export function commandLabel(raw: string): string {
  const shell = raw.match(/^(?:\/\S+\/)?(?:zsh|bash|sh)\s+-[a-z]*c\s+([\s\S]+)$/);
  const wrapped = shell ? shell[1] : raw;
  return /^(['"])[\s\S]*\1$/.test(wrapped) ? wrapped.slice(1, -1) : wrapped;
}
