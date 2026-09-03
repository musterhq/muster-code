// Vendored from VS Code 1.126 (proposal: terminalDataWriteEvent).
declare module 'vscode' {
	export interface TerminalDataWriteEvent {
		readonly terminal: Terminal;
		readonly data: string;
	}
	export namespace window {
		export const onDidWriteTerminalData: Event<TerminalDataWriteEvent>;
	}
}
