/** Accelerators registered in src/main/menu.ts (tests keep the two in step), shown read-only in Settings. */
export interface Shortcut { group: string; label: string; accelerator: string }
export const MENU_SHORTCUTS: readonly Shortcut[] = [
  {group:'App', label:'Settings', accelerator:'Cmd+,'},
  {group:'File', label:'New Chat', accelerator:'CmdOrCtrl+N'},
  {group:'File', label:'Add Folder', accelerator:'CmdOrCtrl+O'},
  {group:'File', label:'Close Tab', accelerator:'CmdOrCtrl+W'},
  {group:'Edit', label:'Find in Chat', accelerator:'CmdOrCtrl+F'},
  {group:'View', label:'Toggle Sidebar', accelerator:'CmdOrCtrl+B'},
  {group:'View', label:'Toggle Resources', accelerator:'Alt+CmdOrCtrl+B'},
  {group:'View', label:'Search Chats', accelerator:'CmdOrCtrl+K'},
  {group:'View', label:'Back', accelerator:'CmdOrCtrl+['},
  {group:'View', label:'Forward', accelerator:'CmdOrCtrl+]'},
  {group:'Work', label:'Stop', accelerator:'CmdOrCtrl+.'},
  {group:'Work', label:'Open Terminal', accelerator:'CmdOrCtrl+J'},
  {group:'Work', label:'Rename Chat', accelerator:'Alt+CmdOrCtrl+R'},
  {group:'Work', label:'Pin Chat', accelerator:'Alt+CmdOrCtrl+P'},
  {group:'Work', label:'Archive Chat', accelerator:'Shift+CmdOrCtrl+A'},
  {group:'Work', label:'Next Chat', accelerator:'Ctrl+Tab'},
  {group:'Work', label:'Previous Chat', accelerator:'Ctrl+Shift+Tab'},
  {group:'Work', label:'Chat 1–9', accelerator:'CmdOrCtrl+1'},
];

const MAC: Record<string, string> = {CmdOrCtrl:'⌘', Cmd:'⌘', Ctrl:'⌃', Alt:'⌥', Shift:'⇧', Tab:'Tab'};
const OTHER: Record<string, string> = {CmdOrCtrl:'Ctrl', Cmd:'Ctrl', Ctrl:'Ctrl', Alt:'Alt', Shift:'Shift', Tab:'Tab'};
/** Electron accelerator to display keys, in macOS modifier order (⌃⌥⇧⌘). */
export function acceleratorKeys(accelerator: string, mac: boolean): string[] {
  const parts = accelerator.split('+'), key = parts.pop() ?? '';
  const order = ['Ctrl', 'Alt', 'Shift', 'Cmd', 'CmdOrCtrl'];
  const mods = parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(mod => (mac ? MAC : OTHER)[mod] ?? mod);
  const last = key === '1' && accelerator.startsWith('CmdOrCtrl+1') ? '1…9' : key;
  return [...mods, (mac ? MAC : OTHER)[last] ?? last];
}
