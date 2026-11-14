/** The calm banner over a computer's chats while it can't be reached (#326 phase 4): Offline with the last update time and
 *  Retry, or Reconnecting while the link comes back. What is on screen is the last known state. */
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Animated from 'react-native-reanimated';
import type {LinkPath} from '../connection/link';
import {clock} from '../time';
import {floatEnter} from '../motion';
import {space, themed, touch, type} from '../theme';

export function ConnectionBanner({name, path, lastSync, onRetry}: {name: string; path: LinkPath; lastSync: number | null; onRetry(): void}) {
  const styles = useStyles();
  const offline = path === 'offline' || path === 'revoked';
  return (
    <Animated.View entering={floatEnter} style={styles.banner} accessibilityRole="summary" accessibilityLiveRegion="polite">
      <Text style={styles.icon}>{offline ? '☁︎' : '↻'}</Text>
      <View style={styles.body}>
        <Text style={styles.title}>{offline ? `Offline${lastSync ? ` · last update ${clock(lastSync)}` : ''}` : `Reconnecting to ${name}…`}</Text>
        <Text style={styles.sub}>{offline ? `Showing what ${name} sent last. The agent may have moved on since then.` : 'What you write waits in the outbox and goes out when it is back.'}</Text>
      </View>
      {offline ? <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={onRetry} hitSlop={8} style={styles.retry}><Text style={styles.retryText}>Retry</Text></Pressable> : null}
    </Animated.View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  banner: {flexDirection: 'row', alignItems: 'center', gap: space.m, marginHorizontal: space.m, marginVertical: space.s, padding: space.m, borderRadius: 14, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border},
  icon: {color: c.muted, fontSize: 16},
  body: {flex: 1, gap: 2},
  title: {color: c.strong, ...type.label, fontWeight: '600'},
  sub: {color: c.faint, ...type.caption},
  retry: {minHeight: touch - 12, paddingHorizontal: space.m, justifyContent: 'center', borderRadius: 16, backgroundColor: c.raised},
  retryText: {color: c.strong, ...type.label, fontWeight: '600'},
}));
