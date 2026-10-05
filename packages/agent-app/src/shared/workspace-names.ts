/**
 * Every user-facing name in Muster's Paperclip-style surfaces (#115), in Muster's own vocabulary. The layout follows
 * Paperclip; the words do not. Renaming a surface is a one-line change here.
 */
export const NAMES = {
  inbox: 'Inbox',
  /** The person's own open work across every org (#117). */
  myWork: 'My work',
  tasks: 'Tasks',
  projects: 'Projects',
  /** Paperclip "routines": Muster's Automations, reused. */
  automations: 'Automations',
  /** Paperclip "artifacts". */
  outputs: 'Outputs',
  /** Paperclip "agents" / org chart. */
  roster: 'Roster',
  /** Paperclip "connectors"; also where Muster Server is connected. */
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
  /** Paperclip "dashboard": live agents, metric tiles, 14-day charts, recent activity and tasks. */
  dashboard: 'Dashboard',
  /** Paperclip "configuration" on a project. */
  settings: 'Settings',
  budget: 'Budget',
  /** A project's mailbox (renamed from "Inbox" so it never clashes with the app-wide Inbox, #186). */
  mail: 'Mail',
  skills: 'Skills',
  /** Sidebar group headings. */
  work: 'Work',
  org: 'Org',
  /** Paperclip "hire an agent". */
  addAgent: 'Add agent',
  /** The one product name for the connected server, whichever backend it is. */
  paperclip: 'Muster Server',
  musterServer: 'Muster Server',
  /** Short form for group labels ("RagnarDataOps · Server") and counts ("2 server agents"). */
  server: 'Server',
} as const;

/** The Inbox's buckets, in filter order (All comes first). The badge counts only Needs you and Problems. */
export const INBOX_BUCKETS = { needs: 'Needs you', done: 'Done', review: 'Review', problems: 'Problems', mentions: 'Mail' } as const;
