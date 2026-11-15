/** The computer's chats in the v3 layout (MUS-SPEC-23-24B): two-line rows (what the chat is, and what it is doing now) with a
 *  36 pt status glyph, grouped into Active (running or waiting on the person) and Earlier. No filter chips: search lives in the
 *  tab bar. A chat that starts running moves into Active with a selection tick. With several computers shown together each
 *  row names its computer; a computer that can't be reached shows its cached chats under a calm banner, a running chat
 *  reading "Was running" (#326 phase 4). */
import {memo, useEffect, useMemo, useRef, useState, type ReactElement} from 'react';
import {Pressable, RefreshControl, StyleSheet, Text, TextInput, View} from 'react-native';
import {LegendList} from '@legendapp/list/react-native';
import type {MobileChat, MobileConnection} from '../shared';
import {errorText} from '../hooks';
import {haptics} from '../haptics';
import {ago} from '../time';
import {offlineOf} from '../offline/connection';
import {ConnectionBanner} from '../components/ConnectionBanner';
import type {LinkPath} from '../connection/link';
import {Icon} from '../components/Icon';
import {GLYPH_WORD, glyphColor, glyphOf, Shimmer, StatusGlyph} from '../components/v3';
import {TAB_BAR_SPACE} from '../components/GlassTabBar';
import {size, space, themed, type, useTheme} from '../theme';

export {ago};
const ACTIVE = new Set<MobileChat['status']>(['running', 'stopping', 'waiting']);
const isActive = (chat: MobileChat) => ACTIVE.has(chat.status) || chat.needsYou > 0;
/** What a chat is doing now, in plain words (the lead word is coloured for a chat that needs the person or failed). */
function doing(chat: MobileChat, offline: boolean): {lead?: string; text: string} {
  switch (chat.status) {
    case 'running': return {text: offline ? 'Was running' : 'Working'};
    case 'stopping': return {text: 'Stopping'};
    case 'waiting': return {lead: 'Needs you', text: ''};
    case 'failed': return {lead: 'Failed', text: ''};
    case 'interrupted': return {text: 'Stopped'};
    case 'completed': return {text: 'Done'};
    default: return {text: ''};
  }
}

/** One computer's chats, as the screen gets them. `path` is how the phone reaches it (for the banner). */
export interface ChatSource { id: string; name: string; connection: MobileConnection; path?: LinkPath }
interface Row { key: string; chat: MobileChat; computerId: string; computer: string | null; offline: boolean }
type Entry = {header: string} | Row;

const ChatRow = memo(function ChatRow({row, onOpen}: {row: Row; onOpen(chatId: string, computerId: string): void}) {
  const styles = useStyles(), c = useTheme();
  const {chat} = row, kind = glyphOf(chat.status, row.offline), what = doing(chat, row.offline);
  const rest = [row.computer, chat.place, what.text].filter(Boolean).join(' · ');
  const line = what.lead ? [what.lead, rest].filter(Boolean).join(' · ') : rest;
  return (
    <Pressable testID={`chat-row-${chat.id}`} accessibilityRole="button" accessibilityLabel={`${chat.title}, ${GLYPH_WORD[kind]}${line && line !== GLYPH_WORD[kind] ? `, ${line}` : ''}`}
      onPress={() => onOpen(chat.id, row.computerId)} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.lead}><StatusGlyph kind={kind} /></View>
      <View style={styles.body}>
        <View style={styles.top}>
          <Text style={styles.title} numberOfLines={1}>{chat.title}</Text>
          <Text style={styles.time}>{ago(chat.updatedAt)}</Text>
        </View>
        {kind === 'running' ? <Shimmer text={rest} style={styles.preview} />
          : <Text style={styles.preview} numberOfLines={1}>
            {what.lead ? <Text style={{color: glyphColor(c, kind), fontWeight: '500'}}>{what.lead}</Text> : null}
            {what.lead && rest ? ' · ' : ''}{rest}
          </Text>}
      </View>
    </Pressable>
  );
});

function Header({label}: {label: string}) {
  const styles = useStyles();
  return <View accessibilityRole="header" accessibilityLabel={label} style={styles.header}><Text style={styles.headerText}>{label}</Text></View>;
}

const tags = new WeakMap<MobileConnection, number>();
let lastTag = 0;
/** Changes when a source is added, removed or gets a new connection (a reconnect, or going offline). */
const sourcesKey = (sources: ChatSource[]): string => sources.map(source => { let tag = tags.get(source.connection); if (!tag) tags.set(source.connection, tag = ++lastTag); return `${source.id}#${tag}`; }).join(',');

/** The chats of every source, kept live: a list call per source, then its chats events. */
function useChatsFrom(sources: ChatSource[]) {
  const [lists, setLists] = useState<Record<string, MobileChat[]>>({});
  const [error, setError] = useState<string | null>(null);
  const key = sourcesKey(sources);
  const load = (source: ChatSource) => source.connection.call('chats.list', {}).then(result => { setLists(current => ({...current, [source.id]: result.chats})); setError(null); }, failure => setError(errorText(failure)));
  useEffect(() => {
    setLists({});
    const offs = sources.map(source => {
      void load(source);
      return source.connection.on(event => { if (event.type === 'chats') setLists(current => ({...current, [source.id]: event.chats})); });
    });
    return () => { for (const off of offs) off(); };
  }, [key]);
  const ready = sources.every(source => lists[source.id]);
  return {lists: ready ? lists : null, error, refresh: () => Promise.all(sources.map(load))};
}

/** `header`: the screen's large title, scrolled with the list. `searching`: show the search field (from the tab bar). */
export function ChatsScreen({connection, sources: given, onOpen, header, searching = false, empty}: {connection?: MobileConnection; sources?: ChatSource[]; onOpen(chatId: string, computerId: string): void; header?: ReactElement; searching?: boolean; empty?: ReactElement}) {
  const styles = useStyles(), c = useTheme();
  const sources = given ?? (connection ? [{id: '', name: connection.desktopName, connection}] : []);
  const {lists, error, refresh} = useChatsFrom(sources);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const several = sources.length > 1;
  const rows = useMemo(() => !lists ? null : sources.flatMap(source => (lists[source.id] ?? []).map((chat): Row => ({key: `${source.id}:${chat.id}`, chat, computerId: source.id, computer: several ? source.name : null, offline: Boolean(offlineOf(source.connection))})))
    .sort((a, b) => b.chat.updatedAt.localeCompare(a.chat.updatedAt)), [lists, several, sourcesKey(sources)]);
  // A row moving into Active gives one selection tick (not on the first load).
  const active = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!rows) return;
    const now = new Set(rows.filter(row => isActive(row.chat)).map(row => row.key));
    if (active.current && [...now].some(key => !active.current!.has(key))) haptics.select();
    active.current = now;
  }, [rows]);
  const entries = useMemo((): Entry[] => {
    const needle = searching ? query.trim().toLowerCase() : '';
    const shown = (rows ?? []).filter(row => !needle || row.chat.title.toLowerCase().includes(needle) || (row.chat.place ?? '').toLowerCase().includes(needle));
    const now = shown.filter(row => isActive(row.chat)), earlier = shown.filter(row => !isActive(row.chat));
    return [...(now.length ? [{header: 'Active'}, ...now] : []), ...(earlier.length ? [{header: 'Earlier'}, ...earlier] : [])];
  }, [rows, query, searching]);
  const pull = () => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)); };
  const top = (
    <View>
      {header}
      {searching ? <View style={styles.search}>
        <Icon name="search" size={18} color={c.muted} />
        <TextInput style={styles.searchInput} placeholder="Search chats" placeholderTextColor={c.muted} value={query} onChangeText={setQuery} autoFocus autoCorrect={false} returnKeyType="search" />
      </View> : null}
      {sources.map(source => { const offline = offlineOf(source.connection); return offline ? <ConnectionBanner key={source.id} name={source.name} path={source.path ?? 'offline'} lastSync={offline.cache.lastSync(offline.computerId)} onRetry={offline.retry} /> : null; })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
  return (
    <View style={styles.screen}>
      <LegendList
        testID="chats-list"
        data={entries}
        keyExtractor={entry => 'header' in entry ? `h:${entry.header}` : entry.key}
        getItemType={entry => 'header' in entry ? 'header' : 'row'}
        estimatedItemSize={size.chatRow}
        recycleItems={false}
        ListHeaderComponent={top}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={c.muted} />}
        ListEmptyComponent={rows ? (query ? <Text style={styles.empty}>No chats match “{query}”.</Text> : empty ?? <Text style={styles.empty}>{`No chats on ${several ? 'your computers' : sources[0]?.name ?? 'your computer'} yet.`}</Text>) : <Skeleton />}
        renderItem={({item: entry}) => 'header' in entry ? <Header label={entry.header} /> : <ChatRow row={entry} onOpen={onOpen} />}
      />
    </View>
  );
}

/** Loading: skeletons the shape of the two-line row, so nothing jumps when the list lands. */
function Skeleton() {
  const styles = useStyles();
  return (
    <View accessibilityLabel="Loading chats" testID="chats-loading">
      {Array.from({length: 6}, (_, index) => (
        <View key={index} style={styles.row}>
          <View style={[styles.lead, styles.skeletonDot]} />
          <View style={[styles.body, {gap: 8, paddingTop: 6}]}><View style={[styles.bar, {width: '55%'}]} /><View style={[styles.bar, {width: '75%', height: 10}]} /></View>
        </View>
      ))}
    </View>
  );
}

const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  content: {paddingBottom: TAB_BAR_SPACE},
  header: {paddingHorizontal: space.margin, paddingTop: space.l, paddingBottom: space.s},
  headerText: {color: c.muted, ...type.footnote, fontWeight: '500'},
  row: {flexDirection: 'row', gap: space.m, minHeight: size.chatRow, paddingTop: space.m, paddingBottom: space.m, paddingLeft: space.l, paddingRight: space.margin},
  pressed: {backgroundColor: c.surface},
  lead: {width: size.glyph, height: 44, alignItems: 'center', justifyContent: 'center'},
  body: {flex: 1, minWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, paddingBottom: space.s},
  top: {flexDirection: 'row', alignItems: 'baseline', gap: space.s},
  title: {flex: 1, color: c.text, ...type.headline},
  time: {color: c.muted, ...type.subhead},
  preview: {color: c.muted, ...type.subhead, marginTop: 3},
  search: {flexDirection: 'row', alignItems: 'center', gap: space.s, marginHorizontal: space.l, marginBottom: space.s, paddingHorizontal: space.m, height: 40, borderRadius: 20, backgroundColor: c.fill},
  searchInput: {flex: 1, color: c.text, ...type.body, paddingVertical: 0},
  empty: {color: c.muted, ...type.callout, padding: space.margin, textAlign: 'center'},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin},
  skeletonDot: {borderRadius: size.glyph / 2, backgroundColor: c.surface, width: size.glyph, height: size.glyph},
  bar: {height: 13, borderRadius: 6, backgroundColor: c.surface},
}));
