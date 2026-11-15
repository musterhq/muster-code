/**
 * #329: the code hosts ("forges") the PR and CI surfaces work with, and the words each one uses. GitLab calls a pull request
 * a merge request (MR) and numbers it `!5`; GitHub and Bitbucket say pull request and `#5`. What each host supports beyond the
 * shared core (list, create, view, comment, checks, merge) is in `FORGE_FEATURES`; the UI hides what a host lacks and the
 * runtime refuses it with a message naming the host.
 */
export type ForgeKind = 'github' | 'gitlab' | 'bitbucket';

export interface ForgeTerms {
  kind: ForgeKind;
  /** GitHub, GitLab, Bitbucket. */
  label: string;
  /** "pull request" / "merge request". */
  noun: string;
  /** "Pull request" / "Merge request". */
  Noun: string;
  /** PR / MR. */
  short: string;
  /** The number prefix: `#` or `!`. */
  sigil: string;
}

export interface ForgeFeatures {
  /** Line-anchored review threads, replies, resolve and line comments. */
  reviewThreads: boolean;
  /** Approve / request changes / comment reviews. */
  reviews: boolean;
  reviewers: boolean;
  markReady: boolean;
  /** Logs of failed checks can be read in the app. */
  checkLogs: boolean;
}

export const FORGE_FEATURES: Record<ForgeKind, ForgeFeatures> = {
  github: {reviewThreads: true, reviews: true, reviewers: true, markReady: true, checkLogs: true},
  gitlab: {reviewThreads: false, reviews: false, reviewers: false, markReady: false, checkLogs: true},
  bitbucket: {reviewThreads: false, reviews: false, reviewers: false, markReady: false, checkLogs: false},
};

const TERMS: Record<ForgeKind, ForgeTerms> = {
  github: {kind: 'github', label: 'GitHub', noun: 'pull request', Noun: 'Pull request', short: 'PR', sigil: '#'},
  gitlab: {kind: 'gitlab', label: 'GitLab', noun: 'merge request', Noun: 'Merge request', short: 'MR', sigil: '!'},
  bitbucket: {kind: 'bitbucket', label: 'Bitbucket', noun: 'pull request', Noun: 'Pull request', short: 'PR', sigil: '#'},
};

/** Words for a host; unknown (no remote yet) reads as GitHub, which is what the surfaces said before #329. */
export const forgeTerms = (kind: ForgeKind | undefined | null): ForgeTerms => TERMS[kind ?? 'github'] ?? TERMS.github;
export const forgeFeatures = (kind: ForgeKind | undefined | null): ForgeFeatures => FORGE_FEATURES[kind ?? 'github'] ?? FORGE_FEATURES.github;
