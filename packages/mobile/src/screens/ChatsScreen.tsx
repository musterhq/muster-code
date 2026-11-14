/** The computer's chats, newest first, in the approved layout: a status dot, the title, the place and what it is doing, and
 *  a count of what waits on the person. Filters for running chats and chats that need you. Updates live. With several
 *  computers shown together each row names its computer; a computer that can't be reached shows its cached chats under a
 *  calm banner, a running chat reading "Was running" (#326 phase 4). */
import {memo, useEffect, useMemo, useState} from 'react';
import {Pressable, RefreshControl, StyleSheet, Text, View} from 'react-native';
import {LegendList} from '@legendapp/list/react-native';
import type {MobileChat, MobileConnection} from '../shared';
import {errorText} from '../hooks';
import {haptics} from '../haptics';
import {ago} from '../time';
import {offlineOf} from '../offline/connection';
import {ConnectionBanner} from '../components/ConnectionBanner';
import type {LinkPath} from '../connection/link';
import {space, themed, touch, type, useTheme, type Palette} from '../theme';

type Filter = 'all' | 'running' | 'needs';
const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['running', 'Running'], ['needs', 'Needs you']];
const RUNNING = new Set<MobileChat['status']>(['running', 'stopping']);

export {ago};
const doing = (chat: MobileChat, offline = false): string => {
  switch (chat.status) {
    case 'running': return offline ? 'Was running' : `Working ${ago(chat.updatedAt)}`;
    case 'stopping': return 'Stopping';
    case 'waiting': return 'Waiting for you';
    case 'failed': return `Failed · ${ago(chat.updatedAt)}`;
    case 'interrupted': return `Stopped · ${ago(chat.updatedAt)}`;
    case 'completed': return `Done · ${ago(chat.updatedAt)}`;
    default: return ago(chat.updatedAt);
  }
};
const dotColor = (c: Palette, status: MobileChat['status']): string =>
  status === 'running' ? c.accent : status === 'waiting' || status === 'stopping' ? c.warning : status === 'completed' ? c.success : status === 'failed' ? c.danger : c.control;

/** One computer's chats, as the screen gets them. `path` is how the phone reaches it (for the banner). */
export interface ChatSource { id: string; name: string; connection: MobileConnection; path?: LinkPath }
interface Row { key: string; chat: MobileChat; computerId: string; computer: string | null; offline: boolean }

const ChatRow = memo(function ChatRow({row, onOpen}: {row: Row; onOpen(chatId: string, computerId: string): void}) {
  const styles = useStyles(), c = useTheme();
  const {chat} = row, what = doing(chat, row.offline);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${chat.title}, ${what}`} onPress={() => onOpen(chat.id, row.computerId)} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      <View style={[styles.dot, {backgroundColor: row.offline ? c.control : dotColor(c, chat.status)}, chat.status === 'running' && !row.offline && styles.dotRunning]} />
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>{chat.title}</Text>
        <Text style={[styles.sub, chat.status === 'failed' && styles.failed]} numberOfLines={1}>{[row.computer, chat.place, what].filter(Boolean).join(' · ')}</Text>
      </View>
      {chat.needsYou ? <Text style={styles.pill} accessibilityLabel={`${chat.needsYou} waiting on you`}>{chat.needsYou}</Text> : null}
    </Pressable>
  );
});

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

export function ChatsScreen({connection, sources: given, onOpen}: {connection?: MobileConnection; sources?: ChatSource[]; onOpen(chatId: string, computerId: string): void}) {
  const styles = useStyles(), c = useTheme();
  const sources = given ?? (connection ? [{id: '', name: connection.desktopName, connection}] : []);
  const {lists, error, refresh} = useChatsFrom(sources);
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const several = sources.length > 1;
  const rows = useMemo(() => !lists ? null : sources.flatMap(source => (lists[source.id] ?? []).map((chat): Row => ({key: `${source.id}:${chat.id}`, chat, computerId: source.id, computer: several ? source.name : null, offline: Boolean(offlineOf(source.connection))})))
    .sort((a, b) => b.chat.updatedAt.localeCompare(a.chat.updatedAt)), [lists, several, sourcesKey(sources)]);
  const shown = useMemo(() => (rows ?? []).filter(({chat}) => filter === 'all' || (filter === 'running' ? RUNNING.has(chat.status) : chat.needsYou > 0)), [rows, filter]);
  const pull = () => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)); };
  return (
    <View style={styles.screen}>
      {sources.map(source => { const offline = offlineOf(source.connection); return offline ? <ConnectionBanner key={source.id} name={source.name} path={source.path ?? 'offline'} lastSync={offline.cache.lastSync(offline.computerId)} onRetry={offline.retry} /> : null; })}
      <View style={styles.segments} accessibilityRole="tablist">
        {FILTERS.map(([value, label]) => (
          <Pressable key={value} accessibilityRole="tab" accessibilityState={{selected: filter === value}} onPress={() => { haptics.select(); setFilter(value); }} style={[styles.segment, filter === value && styles.segmentOn]}>
            <Text style={[styles.segmentText, filter === value && styles.segmentTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <LegendList
        testID="chats-list"
        data={shown}
        keyExtractor={row => row.key}
        estimatedItemSize={62}
        recycleItems={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={c.muted} />}
        ListEmptyComponent={rows ? <Text style={styles.empty}>{filter === 'all' ? `No chats on ${several ? 'your computers' : sources[0]?.name ?? 'your computer'} yet.` : 'Nothing here right now.'}</Text> : <Text style={styles.empty}>Loading…</Text>}
        renderItem={({item: row}) => <ChatRow row={row} onOpen={onOpen} />}
      />
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  segments: {flexDirection: 'row', marginHorizontal: space.m, marginBottom: space.s, padding: 2, borderRadius: 9, backgroundColor: c.surface},
  segment: {flex: 1, minHeight: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7},
  segmentOn: {backgroundColor: c.scheme === 'light' ? c.raised : 'rgba(255,255,255,0.1)'},
  segmentText: {color: c.muted, ...type.label},
  segmentTextOn: {color: c.strong, fontWeight: '600'},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: Math.max(touch, 60), paddingVertical: space.s, paddingHorizontal: space.l, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
  pressed: {backgroundColor: c.surface},
  dot: {width: 8, height: 8, borderRadius: 4},
  dotRunning: {shadowColor: c.accent, shadowOpacity: 0.6, shadowRadius: 3},
  body: {flex: 1, gap: 2},
  title: {color: c.strong, ...type.footnote, fontWeight: '600'},
  sub: {color: c.faint, ...type.caption},
  failed: {color: c.danger},
  pill: {color: c.warning, backgroundColor: c.scheme === 'light' ? 'rgba(160,120,0,0.12)' : 'rgba(224,168,79,0.18)', ...type.caption, fontWeight: '600', paddingHorizontal: space.s, borderRadius: 6, overflow: 'hidden'},
  empty: {color: c.muted, ...type.footnote, padding: space.l, textAlign: 'center'},
  error: {color: c.danger, ...type.label, paddingHorizontal: space.l},
}));
