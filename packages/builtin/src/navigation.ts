export interface NavigationItem { id: string; label: string; description: string; shortcut: string; command: string; args?: unknown }

export interface NavigationHost {
  getCommands(all?: boolean): Thenable<string[]> | Promise<string[]>;
  showQuickPick(items: NavigationItem[], options: { placeHolder: string; matchOnDescription: boolean }): Thenable<NavigationItem | undefined> | Promise<NavigationItem | undefined>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown> | Promise<unknown>;
}

function isRegistered(commands: ReadonlySet<string>, command: string): boolean { return commands.has(command); }

export function navigationItems(commands: Iterable<string>, platform = process.platform): NavigationItem[] {
  const registered = new Set(commands); const mac = platform === "darwin";
  const primary = (mac: string, other: string) => platform === "darwin" ? mac : other;
  const items: NavigationItem[] = [
    { id: "files", label: "$(file) Files", description: "Open a file with the native file picker", shortcut: primary("⌘P", "Ctrl+P"), command: "workbench.action.quickOpen" },
    { id: "commands", label: "$(terminal) Commands", description: "Search every registered command", shortcut: primary("⇧⌘P", "Ctrl+Shift+P"), command: "workbench.action.showCommands" },
    { id: "symbols", label: "$(symbol-method) Symbols", description: "Jump to a symbol in the current file", shortcut: primary("⇧⌘O", "Ctrl+Shift+O"), command: "workbench.action.gotoSymbol" },
    { id: "lines", label: "$(go-to-file) Lines", description: "Go to a line or column", shortcut: primary("⌘G", "Ctrl+G"), command: "workbench.action.gotoLine" },
    { id: "tasks", label: "$(run-all) Tasks", description: "Run an existing workspace task", shortcut: primary("⇧⌘B", "Ctrl+Shift+B"), command: "workbench.action.tasks.runTask" },
    { id: "terminals", label: "$(terminal) Managed terminals", description: "Open the task-labelled terminal workspace", shortcut: primary("⌥⌘T", "Ctrl+Alt+T"), command: "muster.terminal.workspace" },
    { id: "browser", label: "$(globe) Browser", description: "Open the built-in browser", shortcut: primary("⇧⌘B", "Ctrl+Shift+B"), command: "muster.browser.openTab" },
    { id: "review", label: "$(diff) Review", description: "Review current changes", shortcut: primary("⇧⌘R", "Ctrl+Shift+R"), command: "muster.review.open" },
    { id: "appearance", label: "$(paintcan) Appearance", description: "Themes, density, and chat styling", shortcut: "", command: "muster.appearance.open" },
    { id: "wrap", label: "$(word-wrap) Word Wrap", description: "Toggle wrapping in the active editor", shortcut: primary("⌥Z", "Alt+Z"), command: "editor.action.toggleWordWrap" },
  ];
  const workspaceCommands = ["muster.workspace.hub", "muster.workspaces.open", "muster.worktree.open", "muster.orca.open", "muster.omniroute.open"];
  const workspaceCommand = workspaceCommands.find((command) => isRegistered(registered, command));
  if (workspaceCommand) items.push({ id: "workspaces", label: "$(layers) Workspaces", description: "Open worktrees and connected worker spaces", shortcut: "", command: workspaceCommand });
  return items.filter((item) => isRegistered(registered, item.command));
}

export class NavigationHub {
  constructor(private readonly host: NavigationHost) {}

  async open(): Promise<unknown> {
    const commands = await this.host.getCommands(true); const items = navigationItems(commands);
    if (!items.length) return undefined;
    const pick = await this.host.showQuickPick(items, { placeHolder: "Muster: Go To", matchOnDescription: true });
    if (!pick) return undefined;
    return this.host.executeCommand(pick.command, ...(pick.args === undefined ? [] : [pick.args]));
  }
}
