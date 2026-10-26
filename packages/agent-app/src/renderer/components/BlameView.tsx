import React, {useEffect, useMemo, useState} from 'react';
import type {GitBlame} from '../../shared/domains/git-protocol';
import {invoke} from '../bridge';
import {openHistoryTab} from '../store';
import {useStoreSelector} from '../useStore';
import {compactAge, exactTime} from '../relativeTime';
import {codeLanguageFromPath} from './codeLanguage';
import {useHighlightedTokens} from './HighlightedCode';
import {ResourceState} from './ResourceState';
import {cleanIpcError, gitErrorMessage} from './resourceErrors';
import {VirtualRowTable} from './VirtualRowTable';
import {LARGE_FILE_THRESHOLD} from './VirtualFileSource';
import './blame-view.css';

/**
 * GIT-11 blame: the file's source with a gutter naming the commit that last touched each run of lines
 * (short sha · author · age; the commit message on hover). Clicking an annotation opens that commit in History.
 */
export function BlameView({folderId, path, source, targetLine}: {folderId: string; path: string; source: string; targetLine?: number}): React.ReactElement {
  const folder = useStoreSelector(state => state.snapshot?.folders.find(item => item.id === folderId));
  const [blame, setBlame] = useState<{path: string; value?: GitBlame; error?: string}>();
  useEffect(() => {
    let live = true;
    invoke('git.blame', {folderId, path}).then(value => { if (live) setBlame({path, value}); }, cause => { if (live) setBlame({path, error: cleanIpcError(cause) || 'Blame is unavailable for this file.'}); });
    return () => { live = false; };
  }, [folderId, path, source]);
  const lines = useMemo(() => source === '' ? [] : source.split('\n'), [source]);
  // A large file is drawn as plain windowed rows (like the plain source view), so it is not syntax coloured.
  const virtual = source.length >= LARGE_FILE_THRESHOLD;
  const highlighted = useHighlightedTokens(virtual ? '' : source, codeLanguageFromPath(path), 0);
  const indexes = useMemo(() => virtual ? Array.from(lines, (_, index) => index) : [], [virtual, lines]);
  const now = useMemo(() => Date.now(), [blame]);
  const current = blame?.path === path ? blame : undefined;
  if (current?.error) return <ResourceState kind="error" message={gitErrorMessage(current.error) ?? current.error} compact/>;
  if (!current?.value) return <ResourceState kind="loading" label="Reading blame" rows={6} compact/>;
  const {lines: shas, commits, truncated} = current.value;
  const mismatch = shas.length !== lines.length && !(shas.length === lines.length - 1 && lines[lines.length - 1] === '');
  const renderLine = (index: number) => {
    const line = lines[index], sha = shas[index], commit = sha ? commits[sha] : undefined;
    const starts = index === 0 || shas[index - 1] !== sha;
    return <tr data-line={index + 1} className={`${index + 1 === targetLine ? 'file-line-target ' : ''}${starts ? 'blame-run-start' : ''}`.trim() || undefined}>
      <td className="blame-cell">{commit && starts && (commit.uncommitted
        ? <span className="blame-note is-uncommitted" title="Not committed yet">Uncommitted</span>
        : <button type="button" className="blame-note" title={`${commit.summary}\n${commit.author} · ${exactTime(commit.authoredAt)}\n${commit.sha}`} onClick={() => openHistoryTab(folderId, folder?.name ?? 'Repository', commit.sha)}>
          <span className="blame-sha">{commit.short}</span>
          <span className="blame-author">{commit.author}</span>
          <span className="blame-age">{compactAge(commit.authoredAt, now)}</span>
        </button>)}</td>
      <td className="code-no" style={virtual ? {width: 'var(--virtual-gutter)'} : undefined}>{index + 1}</td>
      <td className="code-line">{((!virtual && highlighted?.sourceLines[index] === line ? highlighted.rows[index] : undefined) ?? [{content: line}]).map((token, tokenIndex) => token.color
        ? <span key={tokenIndex} style={{color: token.color}}>{token.content}</span>
        : <React.Fragment key={tokenIndex}>{token.content}</React.Fragment>)}</td>
    </tr>;
  };
  return <div className="blame-view" data-testid="blame-view">
    {mismatch && <div className="pane-truncated">The file changed since blame was computed; annotations may be offset. Reload the file to refresh.</div>}
    {truncated && <div className="pane-truncated">Blame covers the first 20,000 lines.</div>}
    {virtual
      ? <VirtualRowTable<number> className="code-table source-code-table blame-table" items={indexes} columns={3} gutterDigits={String(lines.length).length} extraWidth={260}
          itemKey={index => index} render={renderLine} textOf={index => lines[index]} lineOf={index => index + 1}
          reveal={targetLine && targetLine <= lines.length ? {index: targetLine - 1, token: `line:${targetLine}`} : undefined}/>
      : <table className="code-table source-code-table blame-table"><tbody>{lines.map((_, index) => <React.Fragment key={index}>{renderLine(index)}</React.Fragment>)}</tbody></table>}
  </div>;
}
