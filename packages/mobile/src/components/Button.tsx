import {ActivityIndicator, Pressable, StyleSheet, Text, View} from 'react-native';
import {radius, size, space, themed, type, useTheme} from '../theme';
import {Icon, type IconName} from './Icon';

export type ButtonKind = 'primary' | 'secondary' | 'tint' | 'plain' | 'danger';
/** A v3 capsule: 50 tall (36 with `small`). Primary is the one filled action on a screen or card; plain and danger are text
 *  only. `busy` shows a spinner and ignores presses (no double sends). */
export function Button({label, onPress, kind = 'secondary', disabled = false, busy = false, small = false, icon, grow = false}: {label: string; onPress(): void; kind?: ButtonKind; disabled?: boolean; busy?: boolean; small?: boolean; icon?: IconName; grow?: boolean}) {
  const styles = useStyles(), c = useTheme();
  const off = disabled || busy;
  const fg = kind === 'primary' ? c.onAccent : kind === 'tint' || kind === 'plain' ? c.accent : kind === 'danger' ? c.danger : c.text;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled: off, busy}} disabled={off} onPress={onPress} hitSlop={small ? 4 : 0}
      testID={kind === 'primary' ? 'filled-action' : undefined}
      style={({pressed}) => [styles.base, small && styles.small, styles[kind], grow && styles.grow, (pressed || off) && styles.dim]}>
      <View style={styles.row}>
        {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={small ? 16 : 20} color={fg} stroke={2.2} /> : null}
        <Text style={[small ? styles.labelSmall : styles.label, {color: fg}]} numberOfLines={1}>{label}</Text>
      </View>
    </Pressable>
  );
}
const useStyles = themed(c => StyleSheet.create({
  base: {height: size.primary, borderRadius: radius.capsule, paddingHorizontal: space.margin, alignItems: 'center', justifyContent: 'center'},
  small: {height: size.small, borderRadius: radius.small, paddingHorizontal: 14},
  grow: {flex: 1},
  primary: {backgroundColor: c.accentFill},
  secondary: {backgroundColor: c.fill},
  tint: {backgroundColor: c.accentTint},
  plain: {backgroundColor: 'transparent'},
  danger: {backgroundColor: 'transparent'},
  dim: {opacity: 0.55},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.s},
  label: {...type.headline},
  labelSmall: {...type.subhead, fontWeight: '600'},
}));
