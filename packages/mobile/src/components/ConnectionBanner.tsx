/** The calm glass banner over a computer's chats while it can't be reached (v3): "Studio Mac is offline", when what is shown
 *  was true, and Retry; or Reconnecting while the link comes back. What is on screen is the last known state. */
import {StyleSheet, Text, View} from 'react-native';
import Animated from 'react-native-reanimated';
import type {LinkPath} from '../connection/link';
import {clock} from '../time';
import {floatEnter} from '../motion';
import {radius, space, themed, type, useTheme} from '../theme';
import {Button} from './Button';
import {Icon} from './Icon';
import {Glass} from './v3';

export function ConnectionBanner({name, path, lastSync, onRetry}: {name: string; path: LinkPath; lastSync: number | null; onRetry(): void}) {
  const styles = useStyles(), c = useTheme();
  const offline = path === 'offline' || path === 'revoked';
  return (
    <Animated.View entering={floatEnter} style={styles.wrap} accessibilityRole="summary" accessibilityLiveRegion="polite">
      <Glass radius={radius.card} style={styles.banner}>
        <Icon name={offline ? 'cloud' : 'refresh'} size={26} color={c.muted} stroke={1.8} />
        <View style={styles.body}>
          <Text style={styles.title}>{offline ? `${name} is offline` : `Reconnecting to ${name}…`}</Text>
          <Text style={styles.sub}>{offline ? (lastSync ? `Showing what it sent at ${clock(lastSync)}` : 'Showing what it sent last') : 'What you write waits in the outbox and goes out when it is back.'}</Text>
        </View>
        {offline ? <Button label="Retry" kind="tint" small onPress={onRetry} /> : null}
      </Glass>
    </Animated.View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  wrap: {marginHorizontal: space.card, marginVertical: space.s},
  banner: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingLeft: space.l, paddingRight: space.m},
  body: {flex: 1, gap: 2},
  title: {color: c.text, ...type.headline},
  sub: {color: c.muted, ...type.footnote},
}));
