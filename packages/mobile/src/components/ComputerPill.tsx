/** The computer pill, top left on every main screen (#326 phase 4): a dot, the computer's name and how the phone reaches it
 *  (LAN, Relay, Reconnecting, Offline). Tapping it opens the computer switcher. */
import {Pressable, StyleSheet, Text, View} from 'react-native';
import type {LinkPath} from '../connection/link';
import {space, themed, type, useTheme, type Palette} from '../theme';

export const pathLabel = (path: LinkPath): string => ({connecting: 'Connecting', lan: 'LAN', relay: 'Relay', reconnecting: 'Reconnecting', offline: 'Offline', revoked: 'Revoked'})[path];
export const pathColor = (c: Palette, path: LinkPath): string => path === 'lan' ? c.success : path === 'relay' ? c.accent : path === 'offline' ? c.control : path === 'revoked' ? c.danger : c.warning;

export function StatusDot({path, size = 7}: {path: LinkPath; size?: number}) {
  const c = useTheme();
  return <View style={{width: size, height: size, borderRadius: size / 2, backgroundColor: pathColor(c, path)}} />;
}

export function ComputerPill({name, path, onPress, label}: {name: string; path: LinkPath; onPress?(): void; label?: string}) {
  const styles = useStyles();
  const how = label ?? pathLabel(path);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Computer: ${name}, ${how}`} accessibilityHint="Switch computers" onPress={onPress} hitSlop={8} style={({pressed}) => [styles.pill, pressed && styles.pressed]}>
      <StatusDot path={path} />
      <Text style={styles.name} numberOfLines={1}>{name}</Text>
      <Text style={styles.path}>{how}</Text>
      {onPress ? <Text style={styles.chevron}>⌄</Text> : null}
    </Pressable>
  );
}
const useStyles = themed(c => StyleSheet.create({
  pill: {flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 32, maxWidth: 260, paddingHorizontal: space.m, borderRadius: 16, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border},
  pressed: {backgroundColor: c.raised},
  name: {color: c.text, ...type.label, fontWeight: '600', flexShrink: 1},
  path: {color: c.faint, ...type.micro},
  chevron: {color: c.faint, ...type.micro, marginTop: -4},
}));
