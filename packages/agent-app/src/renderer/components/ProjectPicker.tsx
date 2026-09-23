import { Check, FolderKanban, FolderMinus, Plus } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { Project } from '../../shared/protocol';
import { ComposerMenuList, firstRow, nextRow, type MenuRow } from './ComposerMenu';
import { plural } from '../../shared/wording.ts';

/** "Work in a project": an empty chat moves into the Project; a chat with messages starts a new one there. */
export function ProjectPicker({ projects, currentId, moves, onChoose, onCreate, onClose }: { projects: Project[]; currentId?: string; moves: boolean; onChoose(project: Project | null): void; onCreate(): void; onClose(): void }): React.ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => { const frame = requestAnimationFrame(() => root.current?.focus()); return () => cancelAnimationFrame(frame); }, []);
  const rows: MenuRow[] = [
    ...projects.map(project => ({ key: project.id, section: 'Projects', label: project.name, description: project.goal || `${plural(project.folderIds.length, 'folder')}`,
      icon: project.id === currentId ? <Check size={15} /> : <FolderKanban size={15} className="is-hued" style={{ '--h': 280 } as React.CSSProperties} />, checked: project.id === currentId, score: 0, run: () => onChoose(project) })),
    ...(currentId && moves ? [{ key: 'none', section: 'Projects', label: 'No project', description: 'Keep this chat outside Projects', icon: <FolderMinus size={15} />, score: 0, run: () => onChoose(null) }] : []),
    { key: 'new', section: 'Projects', label: 'New project…', description: 'Create one on the Projects screen', icon: <Plus size={15} />, score: 0, run: onCreate },
  ];
  const index = rows[active]?.disabled ? firstRow(rows) : Math.min(active, rows.length - 1);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = nextRow(rows, index, event.key === 'ArrowDown' ? 1 : -1); if (next >= 0) setActive(next); }
    else if (event.key === 'Enter') { event.preventDefault(); rows[index]?.run(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  };
  return <div ref={root} data-testid="composer-popover" className="composer-popover composer-project-popover" data-browser-overlay tabIndex={-1} role="dialog" aria-label="Work in a project"
    aria-activedescendant={rows.length ? `composer-project-options-${index}` : undefined} onKeyDown={onKeyDown}>
    <p className="composer-project-hint">{moves ? 'This chat moves into the project you choose.' : 'Starts a new chat in the project you choose.'}</p>
    <ComposerMenuList id="composer-project-options" label="Projects" rows={rows} active={index} onActive={setActive} />
  </div>;
}
