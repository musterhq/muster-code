import type {Folder} from '../../shared/protocol.ts';
import {forgeFor} from '../forge/index.ts';
import {resetPullRequestCache} from '../git-local.ts';
import type {DomainContext, DomainModule} from './types.ts';

/** Pull request domain. Handlers are keyed by the command names in shared/domains/github-protocol.ts; the names say
 *  `github.` for history, but each call goes to the folder's forge (#329): GitHub through runtime/github.ts (the user's
 *  `gh` session), GitLab merge requests and Bitbucket pull requests through runtime/forge/. Tokens never pass through here. */
export function createGitHubDomain(context: DomainContext): DomainModule {
  const folder = (value: unknown): Folder => {
    if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Choose a folder.');
    return context.folderFor(value);
  };
  const number = (value: unknown) => value as number;
  const refresh = (input: Record<string, unknown>) => input.refresh === true;
  /** Local refs changed (a push, a merge): let the summary card and Changes refresh. */
  const changed = (target: Folder) => { resetPullRequestCache(); context.emit({type: 'workspaceChanged', folderId: target.id}); };
  /** The folder and its forge. */
  const at = async (input: Record<string, unknown>) => { const target = folder(input.folderId); return {target, path: target.path, forge: await forgeFor(target.path)}; };
  return {handlers: {
    'github.repo': async input => { const {path, forge} = await at(input); return forge.repo(path, refresh(input)); },
    'github.pr.draft': async input => { const {path, forge} = await at(input); return forge.draft(path, input.base); },
    'github.pr.create': async input => {
      const {target, path, forge} = await at(input);
      try { return await forge.create(path, {base: input.base, title: input.title, body: input.body, draft: input.draft, push: input.push}); }
      finally { changed(target); }
    },
    'github.pr.get': async input => { const {path, forge} = await at(input); return forge.get(path, number(input.number), refresh(input)); },
    'github.pr.checks': async input => { const {path, forge} = await at(input); return forge.checks(path, number(input.number), refresh(input)); },
    'github.pr.files': async input => { const {path, forge} = await at(input); return forge.files(path, number(input.number), refresh(input)); },
    'github.pr.threads': async input => { const {path, forge} = await at(input); return forge.threads(path, number(input.number), refresh(input)); },
    'github.pr.conversation': async input => { const {path, forge} = await at(input); return forge.conversation(path, number(input.number), refresh(input)); },
    'github.pr.comment': async input => { const {path, forge} = await at(input); return forge.comment(path, number(input.number), input.body); },
    'github.pr.reviewComment': async input => { const {path, forge} = await at(input); return forge.reviewComment(path, number(input.number), {path: input.path, line: input.line, side: input.side, body: input.body}); },
    'github.pr.reply': async input => { const {path, forge} = await at(input); return forge.reply(path, number(input.number), input.threadId, input.body); },
    'github.pr.resolve': async input => { const {path, forge} = await at(input); return forge.resolve(path, number(input.number), input.threadId, input.resolved === true); },
    'github.pr.ready': async input => { const {path, forge} = await at(input); return forge.ready(path, number(input.number)); },
    'github.pr.requestReview': async input => { const {path, forge} = await at(input); return forge.requestReviewers(path, number(input.number), input.reviewers); },
    'github.pr.review': async input => { const {path, forge} = await at(input); return forge.review(path, number(input.number), input.event, input.body); },
    'github.pr.merge': async input => {
      const {target, path, forge} = await at(input);
      const result = await forge.merge(path, number(input.number), input.method, input.expectedHeadSha);
      changed(target);
      return result;
    },
  }};
}
