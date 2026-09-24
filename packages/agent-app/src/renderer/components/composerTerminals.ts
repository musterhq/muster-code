import { useEffect, useState } from 'react';
import { invoke, subscribe } from '../bridge';
import { useProcessSummary } from '../processSummary';

/** CS-A1-3: how many terminals of this chat are running now — interactive shells plus owned background commands.
 *  Shells are read once and re-read only when one of them exits or a new one starts writing; commands come from the
 *  shared process summary, so no composer polls. */
export function useRunningTerminals(chatId: string): { shells: number; commands: number } {
  const { summary } = useProcessSummary();
  const commands = (summary?.sessions ?? []).filter(session => session.chatId === chatId && (session.status === 'running' || session.status === 'starting')).length;
  const [shells, setShells] = useState(0);
  useEffect(() => {
    let live = true, known = new Set<string>();
    const read = () => invoke('terminal.list', { chatId }).then(list => {
      if (!live) return;
      const rows = (Array.isArray(list) ? list : []).filter(row => !row.chatId || row.chatId === chatId);
      known = new Set(rows.map(row => row.id));
      setShells(rows.filter(row => row.status === 'running').length);
    }, () => { if (live) setShells(0); });
    void read();
    const off = subscribe(event => {
      if (event.type === 'terminalExit' && known.has(event.id)) void read();
      else if (event.type === 'terminalData' && !known.has(event.id)) { known.add(event.id); void read(); }
    });
    return () => { live = false; off(); };
  }, [chatId]);
  return { shells, commands };
}
