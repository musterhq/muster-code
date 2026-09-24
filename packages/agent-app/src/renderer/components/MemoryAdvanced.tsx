import { ChevronDown, Database, FileDown, FileUp, Layers, ListTree, Share2, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import type {
  MemoryArchive, MemoryBankPreview, MemoryCapability, MemoryDirective, MemoryEngineView, MemoryExportPart,
  MemoryImportPreview, MemoryJob, MemoryMentalModel, MemoryModelRefresh, MemoryObservation, MemoryRecord,
} from '../../shared/domains/memory-protocol';
import { invoke } from '../bridge';
import { compactAge, exactTime } from '../relativeTime';
import { useStore } from '../useStore';
import { Menu, MenuPopup } from './AppMenu';
import { Tip } from './Tooltip';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const REFRESH_LABEL: Record<MemoryModelRefresh, string> = { manual: 'Manual', daily: 'Daily', weekly: 'Weekly', 'after-consolidation': 'After consolidation' };
const PARTS: readonly { id: MemoryExportPart; label: string }[] = [{ id: 'facts', label: 'Facts' }, { id: 'observations', label: 'Observations' }, { id: 'models', label: 'Mental models' }, { id: 'directives', label: 'Directives' }];
const TABS = ['observations', 'models', 'directives', 'export', 'bank'] as const;
type Tab = typeof TABS[number];
const TAB_LABEL: Record<Tab, string> = { observations: 'Observations', models: 'Mental models', directives: 'Directives', export: 'Export & import', bank: 'Bank' };
const TAB_ICON: Record<Tab, React.ComponentType<{ size?: number }>> = { observations: ListTree, models: Layers, directives: ShieldCheck, export: FileDown, bank: Database };

function CapabilityHint({ capability, engine }: { capability: MemoryCapability; engine: MemoryEngineView | undefined }): React.ReactElement | null {
  const view = engine?.capabilities[capability];
  if (!view || view.supported) return null;
  return <p className="memory-capability-hint">{view.reason ?? `Requires ${view.requires}.`} Working locally until then.</p>;
}

function ShareToProject({ record, onShared }: { record: MemoryRecord; onShared: (notice: string) => void }): React.ReactElement | null {
  const state = useStore();
  const projects = (state.snapshot?.projects ?? []).filter(project => !project.archived);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!projects.length) return null;
  const share = async (projectId: string) => {
    setBusy(true);
    try {
      await invoke('memory.share', { projectId, text: record.text, kind: record.kind, provenance: record.provenance, sourceId: record.id });
      onShared('Shared to the project’s memory.');
    } catch (cause) { onShared(errorText(cause)); } finally { setBusy(false); setOpen(false); }
  };
  return (
    <span className="memory-share">
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Tip label="Share to a project"><Menu.Trigger className="icon-button" aria-label="Share to a project" disabled={busy}><Share2 size={13} /></Menu.Trigger></Tip>
        <MenuPopup align="end" className="memory-share-menu" aria-label="Share to a project">
          <div className="ui-menu-label">Share to project</div>
          {projects.map(project => <Menu.Item key={project.id} onClick={() => void share(project.id)}><Layers size={14} aria-hidden="true" /><span>{project.name}</span></Menu.Item>)}
        </MenuPopup>
      </Menu.Root>
    </span>
  );
}

function ObservationsTab({ folderId, engine }: { folderId: string | undefined; engine: MemoryEngineView | undefined }): React.ReactElement {
  const [facts, setFacts] = useState<MemoryRecord[]>();
  const [observations, setObservations] = useState<MemoryObservation[]>([]);
  const [job, setJob] = useState<MemoryJob>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    try {
      const result = await invoke('memory.observations', folderId ? { folderId } : {});
      setFacts(result.facts); setObservations(result.observations); setJob(result.consolidation);
    } catch (cause) { setError(errorText(cause)); }
  };
  useEffect(() => { void load(); }, [folderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const consolidate = async () => {
    setBusy(true); setError('');
    try { setJob(await invoke('memory.consolidate', { ...(folderId ? { folderId } : {}), operationId: `consolidate-${Date.now().toString(36)}` })); await load(); setNotice('Consolidation ran.'); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return (
    <div className="memory-advanced-pane">
      <CapabilityHint capability="consolidation" engine={engine} />
      <div className="memory-advanced-toolbar">
        <span>{facts?.length ?? 0} source fact{facts?.length === 1 ? '' : 's'} · {observations.length} observation{observations.length === 1 ? '' : 's'}</span>
        <button type="button" className="settings-button secondary" disabled={busy || !facts?.length} onClick={() => void consolidate()}><Sparkles size={13} />{busy ? 'Consolidating…' : 'Consolidate now'}</button>
      </div>
      {job && <p className="memory-job-status" data-status={job.status}>Last consolidation: {job.status}{job.detail ? ` · ${job.detail}` : ''} · <time dateTime={job.updatedAt} title={exactTime(job.updatedAt)}>{compactAge(job.updatedAt)}</time></p>}
      {notice && <p className="memory-notice" role="status">{notice}</p>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      {observations.length === 0 ? <p className="memory-empty">No observations yet. Consolidate when there are a few related facts.</p> : <ul className="memory-observations">
        {observations.map(observation => <li key={observation.id} className="memory-observation">
          <p>{observation.text}</p>
          <div className="memory-observation-meta">
            <span>{observation.proofCount ?? observation.sources.length} supporting source{(observation.proofCount ?? observation.sources.length) === 1 ? '' : 's'}</span>
            {observation.updatedAt && <time dateTime={observation.updatedAt} title={exactTime(observation.updatedAt)}>Updated {compactAge(observation.updatedAt)}</time>}
          </div>
        </li>)}
      </ul>}
      {facts && facts.length > 0 && <details className="memory-advanced-details">
        <summary>Source facts ({facts.length})</summary>
        <ul className="memory-fact-list">{facts.map(fact => <li key={fact.id}><span>{fact.text}</span><ShareToProject record={fact} onShared={setNotice} /></li>)}</ul>
      </details>}
    </div>
  );
}

function ModelForm({ folderId, model, onDone }: { folderId: string | undefined; model?: MemoryMentalModel; onDone: (notice: string) => void }): React.ReactElement {
  const [name, setName] = useState(model?.name ?? '');
  const [query, setQuery] = useState(model?.query ?? '');
  const [refresh, setRefresh] = useState<MemoryModelRefresh>(model?.refresh ?? 'manual');
  const [tags, setTags] = useState((model?.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ text: string; sources: number; generatedBy: string }>();
  const tagList = () => tags.split(',').map(tag => tag.trim()).filter(Boolean);
  const runPreview = async () => {
    if (busy || !query.trim()) return;
    setBusy(true); setError('');
    try { setPreview(await invoke('memory.models.preview', { ...(folderId ? { folderId } : {}), query: query.trim(), tags: tagList() })); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim() || !query.trim()) return;
    setBusy(true); setError('');
    try {
      await invoke('memory.models.save', { ...(folderId ? { folderId } : {}), ...(model ? { id: model.id } : {}), name: name.trim(), query: query.trim(), refresh, tags: tagList() });
      onDone(model ? 'Mental model updated.' : 'Mental model saved.');
    } catch (cause) { setError(errorText(cause)); setBusy(false); }
  };
  return (
    <form className="memory-model-form" onSubmit={submit}>
      <input aria-label="Model name" value={name} onChange={event => setName(event.target.value)} placeholder="Name, e.g. Deployment approach" maxLength={200} disabled={busy} required />
      <textarea aria-label="Question this model answers" rows={2} value={query} onChange={event => setQuery(event.target.value)} placeholder="What should this remember the answer to?" maxLength={4096} disabled={busy} required />
      <input aria-label="Model tags" value={tags} onChange={event => setTags(event.target.value)} placeholder="Tags that narrow its notes, e.g. deploy, release (comma separated)" maxLength={1100} disabled={busy} />
      <div className="memory-model-form-row">
        <button type="button" className="settings-button ghost" disabled={busy || !query.trim()} onClick={() => void runPreview()}>Preview</button>
        <label>Refresh<select value={refresh} onChange={event => setRefresh(event.target.value as MemoryModelRefresh)} disabled={busy}>{(Object.keys(REFRESH_LABEL) as MemoryModelRefresh[]).map(value => <option key={value} value={value}>{REFRESH_LABEL[value]}</option>)}</select></label>
        <button type="submit" className="settings-button" disabled={busy || !name.trim() || !query.trim()}>{busy ? 'Working…' : model ? 'Save changes' : 'Create model'}</button>
      </div>
      {preview && <div className="memory-model-preview" aria-label="Mental model preview">
        <p className="memory-model-meta">Preview · not saved · {preview.sources} source{preview.sources === 1 ? '' : 's'} · {preview.generatedBy === 'hindsight' ? 'memory engine reflect' : 'local notes'}</p>
        <div className="md-body memory-model-text">{preview.text}</div>
      </div>}
      {error && <p className="memory-error" role="alert">{error}</p>}
    </form>
  );
}

function ModelRow({ model, folderId, onChanged }: { model: MemoryMentalModel; folderId: string | undefined; onChanged: (notice: string) => void }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'delete' | 'preview' | 'clear' | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ text: string; sources: number }>();
  const [confirmClear, setConfirmClear] = useState(false);
  const runPreview = async () => {
    setBusy('preview'); setError('');
    try { setPreview(await invoke('memory.models.preview', { ...(folderId ? { folderId } : {}), id: model.id })); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const clear = async () => {
    setBusy('clear'); setError('');
    try { await invoke('memory.models.clear', { ...(folderId ? { folderId } : {}), id: model.id }); setConfirmClear(false); setPreview(undefined); onChanged('Mental model cleared. Its source facts are untouched.'); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const refresh = async () => {
    setBusy('refresh'); setError('');
    try { await invoke('memory.models.refresh', { ...(folderId ? { folderId } : {}), id: model.id }); onChanged('Mental model refreshed.'); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const remove = async () => {
    setBusy('delete'); setError('');
    try { await invoke('memory.models.delete', { ...(folderId ? { folderId } : {}), id: model.id }); onChanged('Mental model deleted.'); }
    catch (cause) { setError(errorText(cause)); setBusy(null); }
  };
  return (
    <li className="memory-model" data-stale={model.stale || undefined}>
      <button type="button" className="memory-model-head" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <span className="memory-model-name">{model.name}</span>
        <span className="memory-model-badges">
          {model.stale && <span className="memory-badge memory-badge-stale">Stale</span>}
          <span className="memory-badge">{model.storage === 'engine' ? 'Engine' : 'Local'}</span>
          {model.tags.map(tag => <span key={tag} className="memory-badge memory-badge-tag">#{tag}</span>)}
          {model.clearedAt ? <span className="memory-badge">Cleared</span> : <span className="memory-badge">v{model.versions.at(-1)?.version ?? model.versions.length}</span>}
        </span>
        <ChevronDown size={13} className="memory-model-chevron" aria-hidden="true" />
      </button>
      {expanded && <div className="memory-model-body">
        <p className="memory-model-query">{model.query}</p>
        {model.text ? <div className="md-body memory-model-text">{model.text}</div> : <p className="memory-empty">No generated text. Refresh to build it from current memory.</p>}
        {preview && <div className="memory-model-preview" aria-label="Mental model preview">
          <p className="memory-model-meta">Preview · not saved · {preview.sources} source{preview.sources === 1 ? '' : 's'}</p>
          <div className="md-body memory-model-text">{preview.text}</div>
        </div>}
        {model.staleReason && <p className="memory-capability-hint">{model.staleReason}</p>}
        <p className="memory-model-meta">{model.refreshedAt ? <>Refreshed <time dateTime={model.refreshedAt} title={exactTime(model.refreshedAt)}>{compactAge(model.refreshedAt)}</time></> : 'Never refreshed'} · {REFRESH_LABEL[model.refresh]} refresh</p>
        {error && <p className="memory-error" role="alert">{error}</p>}
        {editing
          ? <ModelForm folderId={folderId} model={model} onDone={notice => { setEditing(false); onChanged(notice); }} />
          : <div className="memory-model-actions">
              <button type="button" className="settings-button ghost" disabled={busy !== null} onClick={() => setEditing(true)}>Edit</button>
              <button type="button" className="settings-button ghost" disabled={busy !== null} onClick={() => void runPreview()}>{busy === 'preview' ? 'Previewing…' : 'Preview'}</button>
              <button type="button" className="settings-button secondary" disabled={busy !== null} onClick={() => void refresh()}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button>
              {confirmClear
                ? <><span className="memory-model-meta">Clear its text and history? Source facts stay.</span>
                    <button type="button" className="settings-button danger" disabled={busy !== null} onClick={() => void clear()}>{busy === 'clear' ? 'Clearing…' : 'Clear'}</button>
                    <button type="button" className="settings-button ghost" disabled={busy !== null} onClick={() => setConfirmClear(false)}>Keep</button></>
                : <button type="button" className="settings-button ghost" disabled={busy !== null || Boolean(model.clearedAt)} onClick={() => setConfirmClear(true)}>Clear</button>}
              <button type="button" className="settings-button danger" disabled={busy !== null} onClick={() => void remove()}><Trash2 size={13} />{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>}
      </div>}
    </li>
  );
}

function ModelsTab({ folderId, engine }: { folderId: string | undefined; engine: MemoryEngineView | undefined }): React.ReactElement {
  const [models, setModels] = useState<MemoryMentalModel[]>();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const load = async () => { try { setModels((await invoke('memory.models.list', folderId ? { folderId } : {})).models); } catch (cause) { setError(errorText(cause)); } };
  useEffect(() => { void load(); }, [folderId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="memory-advanced-pane">
      <CapabilityHint capability="mentalModels" engine={engine} />
      <div className="memory-advanced-toolbar">
        <span>{models?.length ?? 0} mental model{models?.length === 1 ? '' : 's'}</span>
        {!creating && <button type="button" className="settings-button secondary" onClick={() => setCreating(true)}>New mental model</button>}
      </div>
      {creating && <ModelForm folderId={folderId} onDone={message => { setCreating(false); setNotice(message); void load(); }} />}
      {notice && <p className="memory-notice" role="status">{notice}</p>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      {models && models.length === 0 && !creating && <p className="memory-empty">No mental models yet. Save one to keep a named answer to a recurring question.</p>}
      {models && models.length > 0 && <ul className="memory-model-list">{models.map(model => <ModelRow key={model.id} model={model} folderId={folderId} onChanged={message => { setNotice(message); void load(); }} />)}</ul>}
    </div>
  );
}

function DirectiveForm({ folderId, directive, onDone }: { folderId: string | undefined; directive?: MemoryDirective; onDone: (notice: string) => void }): React.ReactElement {
  const [kind, setKind] = useState<'directive' | 'disposition'>(directive?.kind ?? 'directive');
  const [text, setText] = useState(directive?.text ?? '');
  const [priority, setPriority] = useState(directive?.priority ?? 100);
  const [tags, setTags] = useState((directive?.tags ?? []).join(', '));
  const [enabled, setEnabled] = useState(directive?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true); setError('');
    try {
      await invoke('memory.directives.save', { ...(folderId ? { folderId } : {}), directive: { ...(directive ? { id: directive.id } : {}), kind, text: text.trim(), priority, tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), enabled } });
      onDone(directive ? 'Directive updated.' : 'Directive saved.');
    } catch (cause) { setError(errorText(cause)); setBusy(false); }
  };
  return (
    <form className="memory-directive-form" onSubmit={submit}>
      <textarea aria-label="Directive text" rows={2} value={text} onChange={event => setText(event.target.value)} placeholder="A rule or stance agents should follow" maxLength={2000} disabled={busy} required />
      <div className="memory-model-form-row">
        <label>Kind<select value={kind} onChange={event => setKind(event.target.value as 'directive' | 'disposition')} disabled={busy}><option value="directive">Directive</option><option value="disposition">Disposition</option></select></label>
        <label>Priority<input type="number" min={0} max={1000} value={priority} onChange={event => setPriority(Number(event.target.value))} disabled={busy} /></label>
        <label>Tags<input value={tags} onChange={event => setTags(event.target.value)} placeholder="comma, separated" maxLength={512} disabled={busy} /></label>
        <label className="memory-directive-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />Enabled</label>
        <button type="submit" className="settings-button" disabled={busy || !text.trim()}>{busy ? 'Saving…' : directive ? 'Save changes' : 'Add directive'}</button>
      </div>
      {error && <p className="memory-error" role="alert">{error}</p>}
    </form>
  );
}

function DirectivesTab({ folderId }: { folderId: string | undefined }): React.ReactElement {
  const [directives, setDirectives] = useState<MemoryDirective[]>();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const load = async () => { try { setDirectives((await invoke('memory.directives.list', folderId ? { folderId } : {})).directives); } catch (cause) { setError(errorText(cause)); } };
  useEffect(() => { void load(); }, [folderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async (id: string) => {
    try { await invoke('memory.directives.delete', { ...(folderId ? { folderId } : {}), id }); setNotice('Directive deleted.'); void load(); }
    catch (cause) { setError(errorText(cause)); }
  };
  return (
    <div className="memory-advanced-pane">
      <p className="memory-capability-hint">Directives and dispositions are added to a run’s context below the user’s instructions and tool policy; they never override either.</p>
      <div className="memory-advanced-toolbar">
        <span>{directives?.length ?? 0} saved, {directives?.filter(directive => directive.enabled).length ?? 0} enabled</span>
        {!creating && <button type="button" className="settings-button secondary" onClick={() => setCreating(true)}>New directive</button>}
      </div>
      {creating && <DirectiveForm folderId={folderId} onDone={message => { setCreating(false); setNotice(message); void load(); }} />}
      {notice && <p className="memory-notice" role="status">{notice}</p>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      {directives && directives.length === 0 && !creating && <p className="memory-empty">No directives yet.</p>}
      {directives && directives.length > 0 && <ul className="memory-directive-list">{directives.map(directive => <li key={directive.id} className="memory-directive" data-enabled={directive.enabled}>
        {editing === directive.id
          ? <DirectiveForm folderId={folderId} directive={directive} onDone={message => { setEditing(null); setNotice(message); void load(); }} />
          : <>
              <div className="memory-directive-row">
                <span className="memory-badge">{directive.kind}</span>
                <span className="memory-directive-priority">P{directive.priority}</span>
                <p>{directive.text}</p>
              </div>
              <div className="memory-directive-footer">
                <span>{directive.tags.length ? directive.tags.join(', ') : 'No tags'}{!directive.enabled ? ' · Disabled' : ''}</span>
                <button type="button" className="settings-button ghost" onClick={() => setEditing(directive.id)}>Edit</button>
                <button type="button" className="settings-button danger" onClick={() => void remove(directive.id)}><Trash2 size={13} />Delete</button>
              </div>
            </>}
      </li>)}</ul>}
    </div>
  );
}

function ImportDialog({ folderId, archive, onDone, onClose }: { folderId: string | undefined; archive: MemoryArchive; onDone: (notice: string) => void; onClose: () => void }): React.ReactElement {
  const [preview, setPreview] = useState<MemoryImportPreview>();
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void invoke('memory.import.preview', { ...(folderId ? { folderId } : {}), archiveId: archive.id }).then(setPreview, cause => setError(errorText(cause))); }, [archive.id, folderId]);
  const apply = async () => {
    setBusy(true); setError('');
    try {
      const result = await invoke('memory.import.apply', { ...(folderId ? { folderId } : {}), archiveId: archive.id, operationId: `import-${archive.id}`, skipDuplicates });
      onDone(`Imported ${result.imported.facts} fact${result.imported.facts === 1 ? '' : 's'}, ${result.imported.models} model${result.imported.models === 1 ? '' : 's'}, ${result.imported.directives} directive${result.imported.directives === 1 ? '' : 's'}. A backup was taken first.`);
    } catch (cause) { setError(errorText(cause)); setBusy(false); }
  };
  return (
    <div className="memory-import-dialog" role="dialog" aria-label="Review import">
      <h3>Review import</h3>
      {!preview && !error && <p className="memory-empty">Reading the archive…</p>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      {preview && <>
        <p>{preview.importable.facts} fact{preview.importable.facts === 1 ? '' : 's'}, {preview.importable.models} model{preview.importable.models === 1 ? '' : 's'}, {preview.importable.directives} directive{preview.importable.directives === 1 ? '' : 's'} to import. {preview.duplicates} duplicate{preview.duplicates === 1 ? '' : 's'} found.</p>
        {preview.sample.length > 0 && <ul className="memory-import-sample">{preview.sample.map((item, index) => <li key={index}><span className="memory-badge">{item.type}</span>{item.text.slice(0, 140)}</li>)}</ul>}
        {preview.skipped.length > 0 && <ul className="memory-import-skipped">{preview.skipped.map((line, index) => <li key={index}>{line}</li>)}</ul>}
        <label className="memory-directive-enabled"><input type="checkbox" checked={skipDuplicates} onChange={event => setSkipDuplicates(event.target.checked)} />Skip duplicates</label>
      </>}
      <div className="new-memory-actions">
        <button type="button" className="settings-button ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="settings-button" disabled={busy || !preview} onClick={() => void apply()}>{busy ? 'Importing…' : 'Import'}</button>
      </div>
    </div>
  );
}

function ExportTab({ folderId }: { folderId: string | undefined }): React.ReactElement {
  const [parts, setParts] = useState<Set<MemoryExportPart>>(new Set(PARTS.map(part => part.id)));
  const [archives, setArchives] = useState<MemoryArchive[]>();
  const [importing, setImporting] = useState<MemoryArchive>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const load = async () => { try { setArchives((await invoke('memory.archives', {})).archives); } catch (cause) { setError(errorText(cause)); } };
  useEffect(() => { void load(); }, []);
  const doExport = async () => {
    if (!parts.size) return;
    setBusy(true); setError('');
    try {
      const result = await invoke('memory.export', { ...(folderId ? { folderId } : {}), parts: [...parts] });
      setNotice(`Exported ${result.archive.manifest.file.lines} line${result.archive.manifest.file.lines === 1 ? '' : 's'} to ${result.archive.manifest.file.name}.`);
      void load();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  const toggle = (part: MemoryExportPart) => setParts(current => { const next = new Set(current); if (next.has(part)) next.delete(part); else next.add(part); return next; });
  const list = archives ?? [];
  return (
    <div className="memory-advanced-pane">
      <fieldset className="memory-export-parts"><legend>Export</legend>
        {PARTS.map(part => <label key={part.id}><input type="checkbox" checked={parts.has(part.id)} onChange={() => toggle(part.id)} />{part.label}</label>)}
      </fieldset>
      <div className="memory-advanced-toolbar">
        <span>Writes JSONL plus a manifest with counts and the engine version.</span>
        <button type="button" className="settings-button secondary" disabled={busy || !parts.size} onClick={() => void doExport()}><FileDown size={13} />{busy ? 'Exporting…' : 'Export'}</button>
      </div>
      {notice && <p className="memory-notice" role="status">{notice}</p>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      <h3 className="memory-advanced-subhead">Archives</h3>
      {list.length === 0 ? <p className="memory-empty">No exports or backups yet.</p> : <ul className="memory-archive-list">{list.map(archive => <li key={archive.id}>
        <div>
          <span className="memory-badge">{archive.kind}</span>
          <span>{archive.manifest.scope.label} · {archive.manifest.parts.join(', ')}</span>
          <time dateTime={archive.manifest.createdAt} title={exactTime(archive.manifest.createdAt)}>{compactAge(archive.manifest.createdAt)}</time>
        </div>
        <button type="button" className="settings-button ghost" onClick={() => setImporting(archive)}><FileUp size={13} />Import…</button>
      </li>)}</ul>}
      {importing && <ImportDialog folderId={folderId} archive={importing} onClose={() => setImporting(undefined)} onDone={message => { setImporting(undefined); setNotice(message); }} />}
    </div>
  );
}

function BankTab({ folderId, scopeName }: { folderId: string | undefined; scopeName: string }): React.ReactElement {
  const [preview, setPreview] = useState<MemoryBankPreview>();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const load = async () => { try { setPreview(await invoke('memory.bank.preview', folderId ? { folderId } : {})); } catch (cause) { setError(errorText(cause)); } };
  useEffect(() => { void load(); setConfirm(''); }, [folderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async () => {
    if (!preview || confirm !== preview.scopeLabel) return;
    setBusy(true); setError('');
    try {
      const result = await invoke('memory.bank.delete', { ...(folderId ? { folderId } : {}), confirm });
      setNotice(`Deleted ${result.local} local record${result.local === 1 ? '' : 's'}. A backup was saved first (${result.backup.manifest.file.name}).`);
      setConfirm(''); void load();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return (
    <div className="memory-advanced-pane">
      {preview && <dl className="memory-bank-summary">
        <div><dt>Local records</dt><dd>{preview.local}</dd></div>
        <div><dt>Mental models</dt><dd>{preview.models}</dd></div>
        <div><dt>Directives</dt><dd>{preview.directives}</dd></div>
        <div><dt>Bank id</dt><dd><code>{preview.bankId ?? '—'}</code></dd></div>
      </dl>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      {notice && <p className="memory-notice" role="status">{notice}</p>}
      <div className="memory-bank-delete">
        <h3>Delete this bank</h3>
        <p>Removes every local record{preview?.engineDelete ? ' and asks the memory engine to delete its copy' : ' in this scope. The memory engine cannot delete its copy yet, so that side is left untouched'}. A backup is written first. Type <strong>{scopeName}</strong> to confirm.</p>
        <div className="memory-bank-delete-row">
          <input aria-label="Type the scope name to confirm" value={confirm} onChange={event => setConfirm(event.target.value)} placeholder={scopeName} />
          <button type="button" className="settings-button danger" disabled={busy || confirm !== (preview?.scopeLabel ?? scopeName)} onClick={() => void remove()}><Trash2 size={13} />{busy ? 'Deleting…' : 'Delete bank'}</button>
        </div>
      </div>
    </div>
  );
}

/** The advanced memory surface (MEM-06/10/11/12/14/15): observations, mental models, directives, jobs and export — all gated on the negotiated engine capabilities. */
export function MemoryAdvanced({ folderId, scopeName }: { folderId: string | undefined; scopeName: string }): React.ReactElement {
  const [tab, setTab] = useState<Tab>('observations');
  const [engine, setEngine] = useState<MemoryEngineView>();
  useEffect(() => {
    let live = true;
    void invoke('memory.engine', folderId ? { folderId } : {}).then(next => { if (live) setEngine(next); }, () => {});
    return () => { live = false; };
  }, [folderId]);
  const engineLabel = useMemo(() => {
    if (!engine) return 'Checking engine…';
    if (!engine.version) return 'Advanced features run locally on this Mac';
    const advanced = Object.values(engine.capabilities).some(view => view.supported);
    return advanced ? 'Advanced features run in the memory engine' : 'Advanced features run locally · update the memory engine to run them there';
  }, [engine]);
  return (
    <section className="memory-advanced" aria-label="Advanced memory">
      <header className="memory-advanced-header">
        <p className="memory-advanced-engine" title={engine?.version ? `Engine ${engine.version}` : undefined}>{engineLabel}</p>
        <div className="memory-advanced-tabs" role="tablist" aria-label="Advanced memory section">
          {TABS.map(value => { const Icon = TAB_ICON[value]; return <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}><Icon size={13} />{TAB_LABEL[value]}</button>; })}
        </div>
      </header>
      {tab === 'observations' && <ObservationsTab folderId={folderId} engine={engine} />}
      {tab === 'models' && <ModelsTab folderId={folderId} engine={engine} />}
      {tab === 'directives' && <DirectivesTab folderId={folderId} />}
      {tab === 'export' && <ExportTab folderId={folderId} />}
      {tab === 'bank' && <BankTab folderId={folderId} scopeName={scopeName} />}
    </section>
  );
}
