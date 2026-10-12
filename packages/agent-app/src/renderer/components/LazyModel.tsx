import React from 'react';
import {LazyBoundary, lazyNamed} from '../lazyScreens';

// Deliberately not in screenLoaders: preloadScreens() would evaluate three.js at idle after boot for users who never open a model.
const loadViewer = () => import('./ModelViewer');
const LazyModelFile = lazyNamed(loadViewer, 'ModelFile');
const LazyModelViewer = lazyNamed(loadViewer, 'ModelViewer');
const LazyAttachmentModel = lazyNamed(loadViewer, 'AttachmentModel');

/** A workspace model file; `revision` changes reload it. The three.js chunk loads on first use. */
export function ModelFilePane(props: {folderId: string; path: string; revision?: unknown}): React.ReactElement {
  return <LazyBoundary label="3D viewer"><LazyModelFile {...props}/></LazyBoundary>;
}

export function AttachmentModelPane(props: {chatId: string; attachmentId: string; name: string}): React.ReactElement {
  return <LazyBoundary label="3D viewer"><LazyAttachmentModel {...props}/></LazyBoundary>;
}

/** Any model source (file or attachment) in either variant. Inline hosts (chat replies) use this one. */
export function ModelViewerPane(props: React.ComponentProps<typeof import('./ModelViewer').ModelViewer>): React.ReactElement {
  return <LazyBoundary label="3D viewer"><LazyModelViewer {...props}/></LazyBoundary>;
}
