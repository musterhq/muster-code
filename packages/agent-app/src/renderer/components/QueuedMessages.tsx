import { Brain, CircleAlert, Clock, CornerDownRight, GripVertical, Pencil, Play, RotateCw, Sparkles, Trash2 } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { PluginEntry, QueuePause, QueuedMessage, SkillEntry } from '../../shared/protocol';
import { invoke } from '../bridge';
import { openAttachment, openAttachmentOnKey } from '../attachmentOpen';
import { queueRemove, queueUpdate, runtimeMessage } from '../composerBridge';
import { EFFORT_LABELS, queuedSummary, reorderIds, restoreQueueOrder } from './composerMenus';
import { getState, notifyError, notifySuccess } from '../store';
import { fileVisual } from './fileVisual';
import { PluginIcon } from './PluginIcon';
import { plural } from '../../shared/wording.ts';

const leaf = (id: string) => id.replace(/\/+$/, '').split('/').pop() || id;
/** Attachment ids on a queued message carry no name client-side; fetched once per id and cached (module-lifetime,
 * same spirit as the model/effort memory above) since a sent or discarded id's name never changes underneath us. */
const attachmentNameCache = new Map<string, {name: string; mime: string}>();
function useAttachmentNames(chatId: string, ids: readonly string[]): ReadonlyMap<string, {name: string; mime: string}> {
  const [, forceUpdate] = useState(0);
  const key = ids.join(',');
  useEffect(() => {
    const missing = ids.filter(id => !attachmentNameCache.has(id));
    if (!chatId || !missing.length) return;
    let live = true;
    invoke('attachments.info', { chatId, ids: missing }).then(refs => {
      if (!live || !refs.length) return;
      for (const ref of refs) attachmentNameCache.set(ref.id, { name: ref.name, mime: ref.mime });
      forceUpdate(value => value + 1);
    }, () => {});
    return () => { live = false; };
  }, [chatId, key]);
  return attachmentNameCache;
}
/** One small clickable chip per queued file (composer tiles' own click-to-open, scaled down); opens it in the
 * resource pane like every other attachment surface. */
function QueueAttachments({ chatId, ids }: { chatId: string; ids: readonly string[] }): React.ReactElement | null {
  const names = useAttachmentNames(chatId, ids);
  if (!ids.length) return null;
  return <span className="composer-queue-files" aria-label={`${plural(ids.length, 'attachment')}`}>
    {ids.map(id => {
      const info = names.get(id);
      const label = info?.name || 'File';
      const { Icon } = fileVisual(label, info?.mime ?? '');
      const open = () => openAttachment(chatId, { id, name: label });
      return <button key={id} type="button" className="composer-queue-file" title={label} onClick={open} onKeyDown={event => openAttachmentOnKey(event, open)}><Icon size={11} aria-hidden="true"/><span>{label}</span></button>;
    })}
  </span>;
}
/** The chips a queued message carries, drawn like the composer's own (icon + name). */
function QueueChips({ item, skills, plugins }: { item: QueuedMessage; skills: readonly SkillEntry[]; plugins: readonly PluginEntry[] }): React.ReactElement | null {
  if (!item.skillIds?.length && !item.pluginIds?.length && !item.effort) return null;
  return <span className="composer-queue-chips">
    {item.skillIds?.map(id => { const skill = skills.find(entry => entry.id === id), name = skill?.displayName ?? skill?.name ?? leaf(id);
      return <span key={`s:${id}`} data-testid="queue-chip" className="composer-queue-chip is-skill" title={`Skill · ${name}`}>{skill?.icon ? <PluginIcon icon={skill.icon} name={name} shape="skill" size={12} /> : <Sparkles size={11} className="is-skill" />}{name}</span>; })}
    {item.pluginIds?.map(id => { const plugin = plugins.find(entry => entry.id === id), name = plugin?.displayName ?? plugin?.name ?? leaf(id);
      return <span key={`p:${id}`} data-testid="queue-chip" className="composer-queue-chip is-plugin" title={`Plugin · ${name}`}><PluginIcon icon={plugin?.icon} name={name} seed={plugin?.name ?? name} brandColor={plugin?.brandColor} size={12} />{name}</span>; })}
    {item.effort && <span data-testid="queue-chip" className="composer-queue-chip is-effort" title={`Reasoning · ${EFFORT_LABELS[item.effort]}`}><Brain size={11} />{EFFORT_LABELS[item.effort]}</span>}
  </span>;
}

/** CR-15 Undo delete (Codex): re-add the message with its chips and move it back to its old index; attachments were
 *  released with the delete, so the toast says when they could not come back. */
export async function restoreQueuedMessage(chatId: string, item: QueuedMessage, index: number): Promise<void> {
  try {
    const added = await invoke('chat.queue.add', { id: chatId, text: item.text, requestId: crypto.randomUUID(), ...(item.skillIds?.length ? { skillIds: item.skillIds } : {}), ...(item.pluginIds?.length ? { pluginIds: item.pluginIds } : {}), ...(item.effort ? { effort: item.effort } : {}) });
    const ids = (getState().snapshot?.chats.find(chat => chat.id === chatId)?.queue ?? []).map(entry => entry.id);
    const order = restoreQueueOrder(ids.includes(added.id) ? ids : [...ids, added.id], added.id, index);
    if (order.indexOf(added.id) !== order.length - 1) await invoke('chat.queue.reorder', { id: chatId, queueIds: order }).catch(() => undefined);
    notifySuccess(item.attachmentIds?.length ? 'Queued message restored · its attachments were removed with it' : 'Queued message restored');
  } catch (cause) { notifyError(cause); }
}

/** Codex's queued-message list above the composer: drag to reorder, Steer, Edit, Delete, Retry, and the paused banner with Resume. */
export function QueuedMessages({ chatId, items, paused, running = false, skills = [], plugins = [], onNote }: { chatId: string; items: QueuedMessage[]; paused?: QueuePause; running?: boolean; skills?: readonly SkillEntry[]; plugins?: readonly PluginEntry[]; onNote?(message: string): void }): React.ReactElement | null {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string | null; after: boolean } | null>(null);
  const cancelled = useRef(false);
  if (!items.length) return null;
  const ids = items.map(item => item.id);
  const run = async (id: string, action: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(id); setError('');
    try { await action(); return true; } catch (cause) { setError(runtimeMessage(cause)); return false; } finally { setBusy(null); }
  };
  const save = async () => {
    if (!editing || cancelled.current) { cancelled.current = false; return; }
    const item = items.find(entry => entry.id === editing.id);
    if (!item || !editing.text.trim() || editing.text === item.text) { setEditing(null); return; }
    const previous = item.text;
    if (await run(item.id, () => queueUpdate(chatId, item.id, editing.text))) {
      setEditing(null);
      notifySuccess('Queued message edited', { label: 'Undo', run: () => queueUpdate(chatId, item.id, previous).then(() => notifySuccess('Queued message restored'), notifyError) });
    }
  };
  const reorder = (id: string, before: string | null) => {
    const next = reorderIds(ids, id, before);
    if (next.join('\0') !== ids.join('\0')) void run(id, () => invoke('chat.queue.reorder', { id: chatId, queueIds: next }));
  };
  const steer = (item: QueuedMessage) => void run(item.id, async () => {
    const result = await invoke('chat.queue.steer', { id: chatId, queueId: item.id });
    if (result.reason) onNote?.(result.reason);
    else if (result.steered) onNote?.('Sent to the running agent');
    else if (!result.started) onNote?.('The agent could not take it right now · still queued');
  });
  const edit = (item: QueuedMessage) => { cancelled.current = false; setEditing({ id: item.id, text: item.text }); };
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    const id = dragging ?? event.dataTransfer.getData('application/x-muster-queue');
    const target = over; setDragging(null); setOver(null);
    if (!id || !target?.id) return;
    reorder(id, target.after ? ids[ids.indexOf(target.id) + 1] ?? null : target.id);
  };
  return <section className={`composer-queue${paused ? ' is-paused' : ''}`} aria-label={plural(items.length, 'queued follow-up')}>
    {paused && <div className="composer-queue-banner" role="status">
      <span>{paused === 'interrupted' ? 'Queue paused because you interrupted' : 'Queue paused because the last run did not finish'}</span>
      <button type="button" disabled={Boolean(busy)} onClick={() => void run('resume', () => invoke('chat.queue.resume', { id: chatId }))}><Play size={11} />Resume</button>
    </div>}
    <ol onDragOver={event => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }} onDrop={drop}>
      {items.map((item, index) => {
        const failed = Boolean(item.error), marker = over?.id === item.id ? (over.after ? ' is-drop-after' : ' is-drop-before') : '';
        return <li key={item.id} data-testid="queue-item" className={`${busy === item.id ? 'is-busy' : ''}${failed ? ' is-failed' : ''}${dragging === item.id ? ' is-dragging' : ''}${marker}`}
          title={failed ? `This queued message could not be sent. Retry, edit, or delete it to continue the queue.${item.error ? `\n${item.error}` : ''}` : undefined}
          draggable={editing?.id !== item.id && items.length > 1}
          onDragStart={event => { setDragging(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-muster-queue', item.id); }}
          onDragEnd={() => { setDragging(null); setOver(null); }}
          onDragOver={event => { if (!dragging) return; const box = event.currentTarget.getBoundingClientRect(); const after = event.clientY > box.top + box.height / 2; if (over?.id !== item.id || over.after !== after) setOver({ id: item.id, after }); }}
          onKeyDown={event => {
            if (!event.altKey || editing || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
            event.preventDefault();
            reorder(item.id, event.key === 'ArrowUp' ? ids[index - 1] ?? ids[0] : ids[index + 2] ?? null);
          }}>
          {items.length > 1 && <GripVertical size={12} aria-hidden="true" className="composer-queue-grip" />}
          {failed ? <CircleAlert size={12} aria-hidden="true" className="composer-queue-glyph is-failed" /> : <Clock size={12} aria-hidden="true" className="composer-queue-glyph" />}
          {editing?.id === item.id
            ? <input className="composer-queue-edit" aria-label="Edit message" autoFocus value={editing.text}
              onChange={event => setEditing({ id: item.id, text: event.target.value })}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') { event.preventDefault(); void save(); }
                else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; setEditing(null); }
              }}
              onBlur={() => void save()} />
            : <button type="button" className="composer-queue-text" title="Edit message" onClick={() => edit(item)}>{queuedSummary(item.text, 0)}</button>}
          {editing?.id !== item.id && <QueueChips item={item} skills={skills} plugins={plugins} />}
          {item.attachmentIds?.length ? <QueueAttachments chatId={chatId} ids={item.attachmentIds} /> : null}
          <span className="composer-queue-actions">
            {failed
              ? <button type="button" className="composer-queue-labelled" aria-label="Retry" title="Try sending this queued message again" disabled={Boolean(busy)} onClick={() => steer(item)}><RotateCw size={11} />Retry</button>
              : <button type="button" className="composer-queue-labelled" aria-label="Steer" title={running ? 'Submit without interrupting the model' : 'Send now'} disabled={Boolean(busy)} onClick={() => steer(item)}><CornerDownRight size={11} />Steer</button>}
            {editing?.id !== item.id && <button type="button" aria-label="Edit message" title="Edit message" onClick={() => edit(item)}><Pencil size={12} /></button>}
            <button type="button" aria-label="Delete queued message" title="Delete queued message" disabled={Boolean(busy)} onClick={() => void run(item.id, () => queueRemove(chatId, item.id)).then(removed => { if (removed) notifySuccess('Queued message deleted', { label: 'Undo', run: () => restoreQueuedMessage(chatId, item, index) }); })}><Trash2 size={12} /></button>
          </span>
        </li>;
      })}
    </ol>
    {error && <p className="composer-queue-error" role="alert">{error}</p>}
  </section>;
}
