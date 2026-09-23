import type {Chat, Project} from '../shared/protocol';
import type {ScopedComputerRef} from '../shared/scoped-computer-protocol';
import {openTab} from './store';

/** One scope per chat for every launcher: the project's sandbox when the chat has one, otherwise the chat's own. */
export function sandboxTarget(chat: Pick<Chat, 'id' | 'title'>, project?: Pick<Project, 'id' | 'name'>): {scope: ScopedComputerRef; label: string} {
  return project ? {scope: {kind: 'project', id: project.id}, label: project.name} : {scope: {kind: 'chat', id: chat.id}, label: chat.title || 'This chat'};
}

/** Opens the scoped sandbox tab; the title names the scope ("Sandbox · Project X"). Same tab id as openComputerTab, so launchers never duplicate it. */
export function openSandbox(chat: Pick<Chat, 'id' | 'title'>, project?: Pick<Project, 'id' | 'name'>): void {
  const {scope, label} = sandboxTarget(chat, project);
  openTab({id: `computer:${scope.kind}:${scope.id}`, kind: 'computer', scope, title: `Sandbox · ${label}`});
}
