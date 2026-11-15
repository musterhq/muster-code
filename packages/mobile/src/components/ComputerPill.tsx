/** The computer line under every large title (v3): a dot, the computer's name with a chevron, and how it is connected in plain
 *  words. Tapping it opens the computer switcher. The dot and words never flash for blips under 3 seconds (phase 4). */
import {Pressable, StyleSheet, Text, View} from 'react-native';
import type {LinkPath} from '../connection/link';
import {space, themed, type, useTheme, type Palette} from '../theme';
import {Icon} from './Icon';

export const pathLabel = (path: LinkPath): string => ({connecting: 'Connecting', lan: 'LAN', relay: 'Relay', reconnecting: 'Reconnecting', offline: 'Offline', revoked: 'Revoked'})[path];
/** The words under the title: Connected, Reconnecting…, Offline. */
export const pathWords = (path: LinkPath): string => ({connecting: 'Connecting…', lan: 'Connected', relay: 'Connected', reconnecting: 'Reconnecting…', offline: 'Offline', revoked: 'Removed on the computer'})[path];
export const pathColor = (c: Palette, path: LinkPath): string => path === 'lan' || path === 'relay' ? c.success : path === 'offline' ? c.faint : path === 'revoked' ? c.danger : c.warning;

export function StatusDot({path, size = 7}: {path: LinkPath; size?: number}) {
  const c = useTheme();
  return <View style={{width: size, height: size, borderRadius: size / 2, backgroundColor: pathColor(c, path)}} />;
}

export function ComputerPill({name, path, onPress, label}: {name: string; path: LinkPath; onPress?(): void; label?: string}) {
  const styles = useStyles(), c = useTheme();
  const how = label ?? pathLabel(path);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Computer: ${name}, ${how}`} accessibilityHint="Switch computers" onPress={onPress} hitSlop={8} style={({pressed}) => [styles.line, pressed && styles.pressed]}>
      <StatusDot path={path} />
      <Text style={styles.name} numberOfLines={1}>{name}</Text>
      {onPress ? <Icon name="chevD" size={14} color={c.muted} stroke={2.4} /> : null}
      <Text style={styles.path} numberOfLines={1}>{label ? `${label} computers` : pathWords(path)}</Text>
    </Pressable>
  );
}
const useStyles = themed(c => StyleSheet.create({
  line: {flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 28, maxWidth: '100%'},
  pressed: {opacity: 0.6},
  name: {color: c.text, ...type.subhead, fontWeight: '600', flexShrink: 1},
  path: {color: c.muted, ...type.subhead, marginLeft: space.xs},
}));
