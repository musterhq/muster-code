import type {SettingsSection} from '../../store';

export interface SectionInfo { id: SettingsSection; label: string; description: string; keywords: string }
/** Order is the nav order. Keywords cover every row title in the section so search lands on the right page. */
export const SETTINGS_SECTIONS: readonly SectionInfo[] = [
  {id:'general', label:'General', description:'Sending, spelling and your settings file.', keywords:'setup checklist onboarding first run welcome guide get started connect sign in docker permissions default model send key enter command return spellcheck spelling export import backup reset defaults json notifications notification mute quiet monitoring alerts dock badge bounce finished failed inherited provenance'},
  {id:'appearance', label:'Appearance', description:'Theme, text size and accessibility overrides.', keywords:'theme light dark mode system appearance colors text size zoom font scale reduce motion animation reduce transparency blur vibrancy accessibility summary card'},
  {id:'chat', label:'Chat', description:'How work shows up in the conversation.', keywords:'inline diffs file changes code additions removals conversation transcript diff defaults split unified wrap ignore whitespace full file diff text size archive idle chats auto-archive automatic cleanup full access confirmation don\'t ask again permissions'},
  {id:'providers', label:'Providers', description:'Accounts, sign-ins and model endpoints.', keywords:'accounts providers models api key endpoint sign in chatgpt claude openai connection'},
  {id:'models', label:'Models', description:'Which models the picker offers, their capabilities and prices.', keywords:'models model picker visibility hide show hidden catalog capabilities context window images tool search reasoning price pricing cost dollars tokens excluded unavailable'},
  {id:'memory', label:'Memory', description:'What Muster remembers across chats.', keywords:'memory remember hindsight recall facts'},
  {id:'plugins', label:'Skills & plugins', description:'Installed plugins and skills with their scope.', keywords:'plugins skills extensions mcp servers apps inventory scope inheritance'},
  {id:'environments', label:'Environments', description:'Where agents run: this Mac or an isolated Linux sandbox.', keywords:'environments environment sandbox container linux docker local host this mac isolated copy worktree run location'},
  {id:'automations', label:'Automations', description:'Scheduled and file-triggered agent work.', keywords:'automations automation schedule scheduled cron recurring trigger file watch runs history'},
  {id:'shortcuts', label:'Shortcuts', description:'Keyboard shortcuts from the app menus.', keywords:'keyboard shortcuts hotkeys accelerators keys bindings'},
  {id:'diagnostics', label:'Diagnostics', description:'Versions, processes and the runtime log.', keywords:'diagnostics version electron node core log memory cpu processes metrics debug support redacted'},
  {id:'storage', label:'Storage', description:'Disk use by category, with safe cleanup.', keywords:'storage disk space size attachments scratch cleanup clean delete sqlite database worktrees'},
];

/** Every whitespace-separated term must appear in the label, description or keywords. */
export function filterSections(query: string, sections: readonly SectionInfo[] = SETTINGS_SECTIONS): SectionInfo[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...sections];
  return sections.filter(section => {
    const haystack = `${section.label} ${section.description} ${section.keywords}`.toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
