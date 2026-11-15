import {useLocalSearchParams, useRouter} from 'expo-router';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Icon, type IconName} from '../src/components/Icon';
import {radius, space, themed, type, useTheme} from '../src/theme';

/** The chat's tools as a short sheet: its folder's files and source control. */
export default function Tools() {
  const {chat, computer} = useLocalSearchParams<{chat: string; computer?: string}>();
  const router = useRouter();
  const styles = useStyles(), c = useTheme();
  if (!chat) return null;
  const go = (pathname: '/files' | '/git') => { router.back(); router.push({pathname, params: {chat, ...(computer ? {computer} : {})}}); };
  const rows: Array<[string, string, IconName, () => void]> = [
    ['Files', 'Browse and read this chat’s folder', 'folder', () => go('/files')],
    ['Source control', 'Branch, commit, push and pull requests', 'branch', () => go('/git')],
  ];
  return (
    <View style={styles.sheet}>
      <View style={styles.group}>
        {rows.map(([label, note, icon, press], index) => (
          <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={press} style={({pressed}) => [styles.row, index > 0 && styles.divider, pressed && styles.pressed]}>
            <View style={styles.tile}><Icon name={icon} size={18} color={c.accent} stroke={1.9} /></View>
            <View style={styles.body}><Text style={styles.name}>{label}</Text><Text style={styles.note}>{note}</Text></View>
            <Icon name="chevR" size={16} color={c.faint} stroke={2.2} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  sheet: {flex: 1, backgroundColor: c.raised, paddingTop: space.xl},
  group: {marginHorizontal: space.card, backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 62, paddingHorizontal: space.l, paddingVertical: 10},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  pressed: {backgroundColor: c.fill},
  tile: {width: 32, height: 32, borderRadius: 8, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center'},
  body: {flex: 1, gap: 2},
  name: {color: c.text, ...type.body, fontWeight: '500'},
  note: {color: c.muted, ...type.footnote},
}));
