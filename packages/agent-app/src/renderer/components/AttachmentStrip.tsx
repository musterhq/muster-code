import { LoaderCircle, RotateCw, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { AttachmentRef } from '../composerBridge';
import { openAttachment, openAttachmentOnKey } from '../attachmentOpen';
import { formatBytes } from './composerMenus';
import { fileVisual } from './fileVisual';
import { attachmentPdfThumbnail, blobPdfThumbnail, isPdf } from '../pdfThumbnail';
import './attachment-strip.css';

/** USER-34: a PDF tile shows its first page (rendered lazily, cached) in place of the file icon. */
function PdfThumb({ chatId, item, fallback }: { chatId?: string; item: ComposerAttachment; fallback: React.ReactNode }): React.ReactElement {
  const [src, setSrc] = useState<string>();
  const refId = item.ref?.id;
  useEffect(() => {
    if (item.state === 'failed') return;
    let live = true;
    const request = item.file ? blobPdfThumbnail(item.key || item.localId, item.file) : chatId && refId ? attachmentPdfThumbnail(chatId, refId) : undefined;
    request?.then(url => { if (live) setSrc(url); }, () => {});
    return () => { live = false; };
  }, [chatId, refId, item.file, item.key, item.localId, item.state]);
  return src ? <img className="attachment-pdf-thumb" src={src} alt="" aria-hidden="true" draggable={false} /> : <>{fallback}</>;
}

export interface ComposerAttachment {
  localId: string;
  key: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file';
  state: 'staging' | 'ready' | 'failed';
  previewUrl?: string;
  error?: string;
  ref?: AttachmentRef;
  file?: Blob;
}

export function AttachmentStrip({ chatId, items, onRemove, onRetry, onOpen }: { chatId?: string; items: ComposerAttachment[]; onRemove: (localId: string) => void; onRetry: (localId: string) => void;
  /** Lets the caller claim a tile's click instead of the default "open in the resource pane" (return true to claim it) — a sketch tile reopens its drawing this way. */
  onOpen?: (item: ComposerAttachment) => boolean }): React.ReactElement | null {
  if (!items.length) return null;
  return <ul className="attachment-strip" aria-label="Attachments">
    {items.map(item => {
      const { Icon, hue } = fileVisual(item.name, item.mime);
      const status = item.state === 'staging' ? 'Uploading' : item.state === 'failed' ? `Failed: ${item.error ?? 'could not attach'}` : formatBytes(item.size);
      // Only a fully staged file, in a chat that exists (New Chat's attachments precede chat creation), has a runtime
      // id to open in the resource pane; a still-uploading or failed tile stays inert.
      const openable = Boolean(chatId) && item.state === 'ready' && Boolean(item.ref);
      const open = () => { if (onOpen?.(item)) return; if (chatId && item.ref) openAttachment(chatId, { id: item.ref.id, name: item.name }); };
      const body = <>
        {item.kind === 'image' && item.previewUrl
          ? <img className="attachment-thumb" src={item.previewUrl} alt={item.name} draggable={false} />
          : <span className="attachment-file">
            {(() => { const icon = <Icon size={16} aria-hidden="true" className={`attachment-icon${hue === null ? '' : ' is-hued'}`} style={hue === null ? undefined : { '--h': hue } as React.CSSProperties} />; return isPdf(item.name, item.mime) ? <PdfThumb chatId={chatId} item={item} fallback={icon} /> : icon; })()}
            <span className="attachment-meta"><strong>{item.name}</strong><small>{item.state === 'failed' ? item.error ?? 'Could not attach' : item.state === 'staging' ? 'Uploading…' : formatBytes(item.size)}</small></span>
          </span>}
      </>;
      return <li key={item.localId} data-testid="attachment-tile" className={`attachment-chip is-${item.kind} is-${item.state}${openable ? ' is-openable' : ''}`} title={`${item.name} · ${status}`}>
        {openable
          ? <button type="button" className="attachment-open" aria-label={`Open ${item.name}`} onClick={open} onKeyDown={event => openAttachmentOnKey(event, open)}>{body}</button>
          : <span className="attachment-open">{body}</span>}
        {item.state === 'staging' && <span className="attachment-busy" role="status" aria-label={`Uploading ${item.name}`}><LoaderCircle size={14} /></span>}
        {item.state === 'failed' && <button type="button" className="attachment-retry" aria-label={`Retry ${item.name}`} title={item.error} onClick={() => onRetry(item.localId)}><RotateCw size={12} /><span>Retry</span></button>}
        <button type="button" className="attachment-remove" aria-label={`Remove ${item.name}`} onClick={event => { event.stopPropagation(); onRemove(item.localId); }}><X size={11} /></button>
      </li>;
    })}
  </ul>;
}
