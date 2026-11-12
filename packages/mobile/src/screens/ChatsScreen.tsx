/** The computer's chats, newest first, with status and a needs-you badge; updates live. */
import {FlatList, Pressable, RefreshControl, StyleSheet, Text, View} from 'react-native';
import type {MobileChat, MobileConnection} from '../shared';
import {useChats} from '../hooks';
import {colors, font, radius, space} from '../theme';

const STATUS: Record<MobileChat['status'], string> = {idle: '', running: 'Running', stopping: 'Stopping', completed: '', failed: 'Failed', interrupted: 'Stopped', waiting: 'Waiting'};
const DOT: Record<MobileChat['status'], string> = {idle: colors.border, running: colors.accent, stopping: colors.warning, completed: colors.success, failed: colors.danger, interrupted: colors.muted, waiting: colors.warning};

export function ChatsScreen({connection, onOpen}: {connection: MobileConnection; onOpen(chatId: string): void}) {
  const {chats, error, refresh} = useChats(connection);
  return (
    <View style={styles.screen}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={chats ?? []}
        keyExtractor={chat => chat.id}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refresh()} />}
        ListEmptyComponent={chats ? <Text style={styles.muted}>No chats on {connection.desktopName} yet.</Text> : <Text style={styles.muted}>Loading…</Text>}
        renderItem={({item: chat}) => (
          <Pressable accessibilityRole="button" onPress={() => onOpen(chat.id)} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
            <View style={[styles.dot, {backgroundColor: DOT[chat.status]}]} />
            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={1}>{chat.title}</Text>
              {chat.place ? <Text style={styles.muted} numberOfLines={1}>{chat.place}</Text> : null}
            </View>
            {chat.needsYou ? <Text style={styles.badge}>Needs you</Text> : STATUS[chat.status] ? <Text style={styles.status}>{STATUS[chat.status]}</Text> : null}
          </Pressable>
        )}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.m, paddingHorizontal: space.l, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border},
  pressed: {backgroundColor: colors.surface},
  dot: {width: 8, height: 8, borderRadius: 4},
  body: {flex: 1, gap: 2},
  title: {color: colors.text, fontSize: font.body},
  muted: {color: colors.muted, fontSize: font.small, padding: space.s},
  status: {color: colors.muted, fontSize: font.small},
  badge: {color: colors.background, backgroundColor: colors.warning, fontSize: font.small, fontWeight: '600', paddingHorizontal: space.s, paddingVertical: 2, borderRadius: radius.s, overflow: 'hidden'},
  error: {color: colors.danger, padding: space.l},
});
