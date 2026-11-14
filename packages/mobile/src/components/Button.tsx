import {Pressable, StyleSheet, Text} from 'react-native';
import {space, themed, touch, type} from '../theme';

/** A labelled button at least 44 points tall. `busy` shows it working and ignores presses (no double sends). */
export function Button({label, onPress, kind = 'secondary', disabled = false, busy = false}: {label: string; onPress(): void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean}) {
  const styles = useStyles();
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{disabled: off, busy}} disabled={off} onPress={onPress} hitSlop={4}
      style={({pressed}) => [styles.base, kind === 'primary' && styles.primary, kind === 'danger' && styles.danger, (pressed || off) && styles.dim]}>
      <Text style={[styles.label, kind === 'primary' && styles.onAccent, kind !== 'secondary' && styles.strong]}>{label}</Text>
    </Pressable>
  );
}
const useStyles = themed(c => StyleSheet.create({
  base: {minHeight: touch, justifyContent: 'center', paddingHorizontal: space.l, borderRadius: 10, backgroundColor: c.raised, borderWidth: 1, borderColor: c.control, alignItems: 'center'},
  primary: {backgroundColor: c.accentFill, borderColor: c.accentFill},
  danger: {borderColor: c.danger},
  dim: {opacity: 0.6},
  label: {color: c.strong, ...type.footnote, fontWeight: '500'},
  onAccent: {color: c.onAccent},
  strong: {fontWeight: '600'},
}));
