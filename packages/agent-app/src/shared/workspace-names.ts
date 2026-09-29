/**
 * Every user-facing name in Muster's Paperclip-style surfaces (#115), in Muster's own vocabulary. The layout follows
 * Paperclip; the words do not. Renaming a surface is a one-line change here.
 */
export const NAMES = {
  inbox: 'Inbox',
  tasks: 'Tasks',
  projects: 'Projects',
  /** Paperclip "routines": Muster's Automations, reused. */
  automations: 'Automations',
  /** Paperclip "artifacts". */
  outputs: 'Outputs',
  /** Paperclip "agents" / org chart. */
  roster: 'Roster',
  /** Paperclip "connectors"; also where a Paperclip server is linked. */
  integrations: 'Integrations',
  /** Paperclip "audit": Receipts, Timeline, Activity and Costs. */
  ledger: 'Ledger',
  memory: 'Memory',
  /** Heartbeats and wake-ups: the runs board. */
  pulse: 'Pulse',
  /** Per-turn change evidence. */
  receipt: 'Receipt',
  receipts: 'Receipts',
  timeline: 'Timeline',
  newTask: 'New task',
  paperclip: 'Paperclip',
} as const;

/** The Inbox's buckets, in filter order (All comes first). The badge counts only Needs you and Problems. */
export const INBOX_BUCKETS = { needs: 'Needs you', done: 'Done', review: 'Review', problems: 'Problems', mentions: 'Mail' } as const;
