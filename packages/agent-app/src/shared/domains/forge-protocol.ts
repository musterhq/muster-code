/** Forge accounts contract (#329): GitLab and Bitbucket Cloud sign-ins for Settings › Integrations. Tokens go in only;
 *  they are kept in the encrypted secret store and never come back across this seam. */

export interface ForgeAccountView {kind:'gitlab'|'bitbucket'; host:string; username?:string; hasToken:boolean}
export interface ForgeAccounts {
  accounts:ForgeAccountView[];
  /** The glab CLI: whether it runs, and the GitLab hosts it is signed in to (checked: gitlab.com and saved hosts). */
  glab:{installed:boolean; hosts:string[]};
  /** False when there is no OS keychain: tokens can't be saved (glab still works). */
  secureStorage:boolean;
}

export interface ForgeCommands {
  'forge.accounts': {input:Record<string, never>; output:ForgeAccounts};
  'forge.account.save': {input:{kind:'gitlab'|'bitbucket'; host?:string; username?:string; token:string}; output:ForgeAccounts};
  'forge.account.remove': {input:{kind:'gitlab'|'bitbucket'; host?:string}; output:ForgeAccounts};
}
export type ForgeEvent = never;
export const FORGE_COMMANDS = {'forge.accounts': true, 'forge.account.save': true, 'forge.account.remove': true} as const satisfies Record<keyof ForgeCommands, true>;
