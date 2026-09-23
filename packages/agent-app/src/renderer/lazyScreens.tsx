import React, {Suspense, lazy, type ComponentType} from 'react';
import {AreaBoundary} from './components/AreaBoundary';
// Styles: esbuild folds the stylesheets of these lazy chunks into main.css (index.html links only that);
// scripts/build.mjs fails the build if a lazy chunk ever carries a stylesheet missing from main.css.

/**
 * Demand-loaded screens and resource tabs (PER-01). Startup parses only the work surface; Settings,
 * Projects, Memory, Automations and the heavy resource tabs load on first use, and preloadScreens()
 * warms them on idle after boot so opening one never shows a loading state in practice.
 */
export const screenLoaders = {
  projects: () => import('./components/ProjectsScreen'),
  memory: () => import('./components/MemoryScreen'),
  automations: () => import('./components/AutomationsScreen'),
  settings: () => import('./components/PreferencesScreen'),
  pullRequest: () => import('./components/PullRequestTab'),
  history: () => import('./components/GitHistoryTab'),
  computer: () => import('./components/ScopedComputerTab'),
} as const;

/** React.lazy over a named export. */
export function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K): React.LazyExoticComponent<M[K] & ComponentType<any>> {
  return lazy(() => load().then(module => ({default: module[name] as M[K] & ComponentType<any>})));
}

export const LazyProjectsScreen = lazyNamed(screenLoaders.projects, 'ProjectsScreen');
export const LazyMemoryScreen = lazyNamed(screenLoaders.memory, 'MemoryScreen');
export const LazyAutomationsScreen = lazyNamed(screenLoaders.automations, 'AutomationsScreen');
export const LazyPreferencesScreen = lazyNamed(screenLoaders.settings, 'PreferencesScreen');
export const LazyPullRequestTab = lazyNamed(screenLoaders.pullRequest, 'PullRequestTab');
export const LazyGitHistoryTab = lazyNamed(screenLoaders.history, 'GitHistoryTab');
export const LazyScopedComputerTab = lazyNamed(screenLoaders.computer, 'ScopedComputerTab');

/** Quiet placeholder while a chunk loads: no spinner flash, just the surface's own background. */
export function ScreenFallback({label}: {label: string}): React.ReactElement {
  return <div className="lazy-screen-fallback" role="status" aria-busy="true" aria-label={`Loading ${label}`}/>;
}

export function LazyBoundary({label, children}: {label: string; children: React.ReactNode}): React.ReactElement {
  // R3: a render fault (or a chunk that failed to load) stays inside this screen or tab.
  return <AreaBoundary area={label} scope="screen"><Suspense fallback={<ScreenFallback label={label}/>}>{children}</Suspense></AreaBoundary>;
}

let preloaded = false;
/** Warm every lazy chunk once the renderer is idle, so first navigation is instant. Failures are ignored:
 *  the real navigation retries the import and surfaces its own error. */
export function preloadScreens(): void {
  if (preloaded) return;
  preloaded = true;
  const run = () => { for (const load of Object.values(screenLoaders)) void load().catch(() => {}); };
  const idle = (globalThis as {requestIdleCallback?: (cb: () => void, opts?: {timeout: number}) => number}).requestIdleCallback;
  if (idle) idle(run, {timeout: 4000}); else setTimeout(run, 1500);
}
