import { FileText, Link2, NotebookText } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { HandoffPacket, ProjectSource, ProjectSourceKind, ProjectTaskView } from '../../shared/domains/projects-protocol';
import { invoke } from '../bridge';
import { agoLabel as relativeTime } from '../relativeTime.ts';

const KIND_LABEL: Record<ProjectSourceKind, string> = { doc: 'Document', url: 'URL', file: 'File' };
const KIND_ICON: Record<ProjectSourceKind, React.ReactElement> = { doc: <NotebookText size={13}/>, url: <Link2 size={13}/>, file: <FileText size={13}/> };
const errorText = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;

function SourceForm({ projectId, source, onDone, onCancel }: { projectId: string; source?: ProjectSource; onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<ProjectSourceKind>(source?.kind ?? 'doc');
  const [title, setTitle] = useState(source?.title ?? '');
  const [ref, setRef] = useState(source?.ref ?? '');
  const [text, setText] = useState(source?.text ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await invoke('project.sources.save', { projectId, ...(source ? { id: source.id, baseVersion: source.version } : {}), kind, title: title.trim(), ref: ref.trim(), ...(kind === 'doc' ? { text } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      onDone();
    } catch (err) { setError(errorText(err, 'Could not save the source.')); setBusy(false); }
  }
  return <form className="project-inline-edit project-source-form" onSubmit={e => void save(e)}>
    <div className="project-source-form-row">
      <label>Kind<select value={kind} disabled={busy} onChange={e => setKind(e.target.value as ProjectSourceKind)}>{(Object.keys(KIND_LABEL) as ProjectSourceKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
      <label className="grow">Title<input value={title} maxLength={200} disabled={busy} onChange={e => setTitle(e.target.value)} required placeholder="API reference"/></label>
    </div>
    <label>{kind === 'url' ? 'URL' : kind === 'file' ? 'Path' : 'Reference (optional)'}<input value={ref} maxLength={2048} disabled={busy} onChange={e => setRef(e.target.value)} placeholder={kind === 'url' ? 'https://…' : kind === 'file' ? 'docs/architecture.md' : 'Where the original lives'} required={kind !== 'doc'}/></label>
    {kind === 'doc' && <label>Text<textarea rows={4} maxLength={32768} value={text} disabled={busy} onChange={e => setText(e.target.value)} placeholder="Agents see an excerpt with the version; keep it to what runs need."/></label>}
    {source && <label>Change note<input value={note} maxLength={500} disabled={busy} onChange={e => setNote(e.target.value)} placeholder="What changed in this version"/></label>}
    {error && <span role="alert" className="settings-error">{error}</span>}
    <div className="project-task-form-actions"><button type="submit" className="settings-button" disabled={busy || !title.trim()}>{busy ? 'Saving…' : source ? `Save as v${source.version + 1}` : 'Add source'}</button><button type="button" className="settings-button secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </form>;
}

/** PRJ-16: versioned reference material, separate from memory. Every run context names the enabled sources and their versions. */
export function SourcesCard({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [sources, setSources] = useState<ProjectSource[]>();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = () => { void invoke('project.sources.list', { projectId }).then(r => setSources(r.sources), err => setError(errorText(err, 'Could not load sources.'))); };
  useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => { setEditing(null); load(); onChanged(); };
  async function toggle(source: ProjectSource) {
    setBusy(source.id); setError('');
    try { await invoke('project.sources.save', { projectId, id: source.id, kind: source.kind, title: source.title, ref: source.ref, enabled: !source.enabled }); done(); }
    catch (err) { setError(errorText(err, 'Could not update the source.')); } finally { setBusy(null); }
  }
  async function remove(source: ProjectSource) {
    if (!confirm(`Remove source "${source.title}"? Its history goes with it.`)) return;
    setBusy(source.id); setError('');
    try { await invoke('project.sources.remove', { projectId, id: source.id }); done(); }
    catch (err) { setError(errorText(err, 'Could not remove the source.')); } finally { setBusy(null); }
  }
  return <section aria-label="Project sources" className="project-card">
    <header><h3>Sources{sources?.length ? ` (${sources.length})` : ''}</h3>{editing === null && <button type="button" className="project-link" onClick={() => setEditing('new')}>Add</button>}</header>
    {editing === 'new' && <SourceForm projectId={projectId} onDone={done} onCancel={() => setEditing(null)}/>}
    {sources && sources.length === 0 && editing === null && <p className="projects-empty">No reference sources. Add docs, URLs or files that every run should know about; they are versioned apart from memory.</p>}
    {sources && sources.length > 0 && <ul className="project-source-list">{sources.map(source => <li key={source.id} data-disabled={!source.enabled || undefined}>
      {editing === source.id
        ? <SourceForm projectId={projectId} source={source} onDone={done} onCancel={() => setEditing(null)}/>
        : <>
          <span className="project-source-title">{KIND_ICON[source.kind]}<strong>{source.title}</strong><span className="projects-item-meta">v{source.version}{source.enabled ? '' : ' · off'} · {relativeTime(source.updatedAt)}</span></span>
          {source.ref && <span className="project-source-ref" title={source.ref}>{source.ref}</span>}
          <span className="project-task-row-actions">
            <button type="button" className="project-link" disabled={busy === source.id} onClick={() => setEditing(source.id)}>Edit</button>
            <button type="button" className="project-link" disabled={busy === source.id} onClick={() => void toggle(source)}>{source.enabled ? 'Turn off' : 'Turn on'}</button>
            <button type="button" className="project-link" disabled={busy === source.id} onClick={() => void remove(source)}>Remove</button>
          </span>
          {source.history.length > 1 && <details className="project-source-history"><summary>{source.history.length} versions</summary><ul>{[...source.history].reverse().map(h => <li key={h.version}>v{h.version} · {h.note || 'Updated'} · {relativeTime(h.createdAt)}</li>)}</ul></details>}
        </>}
    </li>)}</ul>}
    <p className="projects-item-meta">Changes apply to the next dispatch. Running chats get a notice so you can steer them.</p>
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}

/** PRJ-18: the bounded packet a task's next run receives, its version and which chats acknowledged it. */
export function HandoffCard({ projectId, tasks, onOpenChat }: { projectId: string; tasks: ProjectTaskView[]; onOpenChat: (id: string) => void }) {
  const [taskId, setTaskId] = useState('');
  const [packet, setPacket] = useState<HandoffPacket | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setPacket(undefined); setError('');
    let live = true;
    void invoke('project.handoff.latest', { projectId, ...(taskId ? { taskId } : {}) }).then(r => { if (live) setPacket(r.packet); }, err => { if (live) setError(errorText(err, 'Could not read the handoff.')); });
    return () => { live = false; };
  }, [projectId, taskId]);
  async function build() {
    setBusy(true); setError('');
    try { setPacket(await invoke('project.handoff.build', { projectId, ...(taskId ? { taskId } : {}) })); }
    catch (err) { setError(errorText(err, 'Could not build the handoff.')); } finally { setBusy(false); }
  }
  return <section aria-label="Handoff packet" className="project-card">
    <header><h3>Handoff</h3>
      <select aria-label="Handoff task" value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">Whole Project</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
      <button type="button" className="project-link" disabled={busy} onClick={() => void build()}>{busy ? 'Building…' : packet ? 'Rebuild' : 'Build'}</button>
    </header>
    {packet === null && <p className="projects-empty">No packet yet. A task run builds one automatically; build it here to review what the next agent receives.</p>}
    {packet && <>
      <p className="projects-item-meta">v{packet.version}{packet.stale ? ' · stale: the task or its context changed' : ''} · {packet.memory.length} scoped memor{packet.memory.length === 1 ? 'y' : 'ies'} · {packet.artifacts.length} artifact reference{packet.artifacts.length === 1 ? '' : 's'} · built {relativeTime(packet.createdAt)}</p>
      <pre className="project-handoff-text">{packet.text}</pre>
      {packet.acks.length > 0
        ? <ul className="project-handoff-acks">{packet.acks.map(a => <li key={`${a.chatId}-${a.version}`}><button type="button" className="project-link" onClick={() => onOpenChat(a.chatId)}>{a.via === 'run-start' ? 'Run started from' : 'Acknowledged'} v{a.version}</button> · {relativeTime(a.acknowledgedAt)}</li>)}</ul>
        : <p className="projects-item-meta">Not acknowledged by any chat yet.</p>}
    </>}
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}
