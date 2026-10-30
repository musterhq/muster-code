/** Opening a rich block in the right pane. The tab carries its (bounded) source: the chat remains the record, the tab is a view. */
import {openTab} from './store';
import {richTabId, richTitleOf, type RichKind} from '../shared/rich-fence';

export function openRichTab(kind: RichKind, source: string, title: string = richTitleOf(kind, source)): void {
  openTab({id: richTabId(kind, source), kind: 'rich', richKind: kind, richSource: source, title});
}
