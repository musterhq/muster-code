import {Pressable, StyleSheet, Text} from 'react-native';
import {colors, font, radius, space} from '../theme';

export function Button({label, onPress, kind = 'secondary', disabled = false}: {label: string; onPress(): void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{disabled}} disabled={disabled} onPress={onPress}
      style={({pressed}) => [styles.base, kind === 'primary' && styles.primary, kind === 'danger' && styles.danger, (pressed || disabled) && styles.dim]}>
      <Text style={[styles.label, kind !== 'secondary' && styles.strong]}>{label}</Text>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  base: {paddingVertical: space.s, paddingHorizontal: space.l, borderRadius: radius.s, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, alignItems: 'center'},
  primary: {backgroundColor: colors.accent, borderColor: colors.accent},
  danger: {borderColor: colors.danger},
  dim: {opacity: 0.6},
  label: {color: colors.text, fontSize: font.body},
  strong: {fontWeight: '600'},
});
