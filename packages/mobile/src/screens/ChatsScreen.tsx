/** The computer's chats, newest first, in the approved layout: a status dot, the title, the place and what it is doing, and
 *  a count of what waits on the person. Filters for running chats and chats that need you. Updates live. */
import {memo, useMemo, useState} from 'react';
import {Pressable, RefreshControl, StyleSheet, Text, View} from 'react-native';
import {LegendList} from '@legendapp/list/react-native';
import type {MobileChat, MobileConnection} from '../shared';
import {useChats} from '../hooks';
import {haptics} from '../haptics';
import {space, themed, touch, type, useTheme, type Palette} from '../theme';

type Filter = 'all' | 'running' | 'needs';
const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['running', 'Running'], ['needs', 'Needs you']];
const RUNNING = new Set<MobileChat['status']>(['running', 'stopping']);

/** "4m", "2h", "3d": how long ago. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
const doing = (chat: MobileChat): string => {
  switch (chat.status) {
    case 'running': return `Working ${ago(chat.updatedAt)}`;
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

const ChatRow = memo(function ChatRow({chat, onOpen}: {chat: MobileChat; onOpen(chatId: string): void}) {
  const styles = useStyles(), c = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${chat.title}, ${doing(chat)}`} onPress={() => onOpen(chat.id)} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      <View style={[styles.dot, {backgroundColor: dotColor(c, chat.status)}, chat.status === 'running' && styles.dotRunning]} />
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>{chat.title}</Text>
        <Text style={[styles.sub, chat.status === 'failed' && styles.failed]} numberOfLines={1}>{[chat.place, doing(chat)].filter(Boolean).join(' · ')}</Text>
      </View>
      {chat.needsYou ? <Text style={styles.pill} accessibilityLabel={`${chat.needsYou} waiting on you`}>{chat.needsYou}</Text> : null}
    </Pressable>
  );
});

export function ChatsScreen({connection, onOpen}: {connection: MobileConnection; onOpen(chatId: string): void}) {
  const styles = useStyles(), c = useTheme();
  const {chats, error, refresh} = useChats(connection);
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const shown = useMemo(() => (chats ?? []).filter(chat => filter === 'all' || (filter === 'running' ? RUNNING.has(chat.status) : chat.needsYou > 0)), [chats, filter]);
  const pull = () => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)); };
  return (
    <View style={styles.screen}>
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
        keyExtractor={chat => chat.id}
        estimatedItemSize={62}
        recycleItems={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={c.muted} />}
        ListEmptyComponent={chats ? <Text style={styles.empty}>{filter === 'all' ? `No chats on ${connection.desktopName} yet.` : 'Nothing here right now.'}</Text> : <Text style={styles.empty}>Loading…</Text>}
        renderItem={({item: chat}) => <ChatRow chat={chat} onOpen={onOpen} />}
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
