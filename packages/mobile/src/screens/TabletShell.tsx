/** Tablets, foldables and landscape (#326 phase 4). Compact widths get the phone layout. Medium widths show the chat list
 *  beside the open chat; expanded widths add an inspector with what needs the person. The sidebar collapses; the chat
 *  column is capped at 760 points. Splitting exactly at an Android foldable's hinge needs a native module and comes later. */
import {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {CHAT_COLUMN_MAX, INSPECTOR_WIDTH, SIDEBAR_WIDTH, widthClass} from '../layout';
import {haptics} from '../haptics';
import {space, themed, touch, type} from '../theme';
import {ChatsHome, type ComputersProps} from './ChatsHome';
import {ChatScreen} from './ChatScreen';
import {NeedsYouScreen} from './NeedsYouScreen';

export function TabletShell(props: ComputersProps & {width: number; onOpen?(chatId: string, computerId: string): void}) {
  const styles = useStyles();
  const {width, computers, selectedId, showAll, onOpen} = props;
  const [open, setOpen] = useState<{chatId: string; computerId: string} | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const size = widthClass(width);
  if (size === 'compact') return <ChatsHome {...props} onOpen={(chatId, computerId) => onOpen ? onOpen(chatId, computerId) : setOpen({chatId, computerId})} />;
  const shown = (showAll ? computers : computers.filter(view => view.id === (selectedId ?? computers[0]?.id))).filter(view => view.connection);
  const current = open ? computers.find(view => view.id === open.computerId) : undefined;
  const toggle = () => { haptics.select(); setSidebar(on => !on); };
  return (
    <View style={styles.row}>
      {sidebar ? <View style={styles.sidebar} testID="tablet-sidebar"><ChatsHome {...props} onOpen={(chatId, computerId) => setOpen({chatId, computerId})} /></View> : null}
      <View style={styles.center}>
        <View style={styles.toolbar}>
          <Pressable accessibilityRole="button" accessibilityLabel={sidebar ? 'Hide sidebar' : 'Show sidebar'} onPress={toggle} hitSlop={8} style={styles.tool}><Text style={styles.toolText}>{sidebar ? '⟨' : '☰'}</Text></Pressable>
        </View>
        <View style={styles.column} testID="chat-column">
          {open && current?.connection ? <ChatScreen key={`${open.computerId}:${open.chatId}`} connection={current.connection} chatId={open.chatId} path={current.path} />
            : <Text style={styles.empty}>Choose a chat.</Text>}
        </View>
      </View>
      {size === 'expanded' ? <View style={styles.inspector} testID="inspector">
        <Text style={styles.heading}>Needs you</Text>
        <NeedsYouScreen sources={shown.map(view => ({id: view.id, name: view.name, connection: view.connection!}))} onOpen={(chatId, computerId) => setOpen({chatId, computerId})} />
      </View> : null}
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  row: {flex: 1, flexDirection: 'row', backgroundColor: c.background},
  sidebar: {width: SIDEBAR_WIDTH, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: c.border},
  center: {flex: 1},
  toolbar: {flexDirection: 'row', paddingHorizontal: space.s, minHeight: touch, alignItems: 'center'},
  tool: {width: touch, height: touch, alignItems: 'center', justifyContent: 'center'},
  toolText: {color: c.muted, ...type.headline},
  column: {flex: 1, width: '100%', maxWidth: CHAT_COLUMN_MAX, alignSelf: 'center'},
  empty: {color: c.faint, ...type.body, textAlign: 'center', marginTop: space.xl},
  inspector: {width: INSPECTOR_WIDTH, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.border},
  heading: {color: c.muted, ...type.caption, fontWeight: '600', textTransform: 'uppercase', padding: space.m, paddingBottom: 0},
}));
