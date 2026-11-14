/** This phone and the computer it is paired with; Unpair forgets the keys on this phone. */
import {StyleSheet, Text, View} from 'react-native';
import {Button} from '../components/Button';
import {font, space, themed, useTheme} from '../theme';

export function SettingsScreen({desktopName, access, status, onUnpair}: {desktopName: string; access: string | null; status: string; onUnpair(): void}) {
  const styles = useStyles(), colors = useTheme();
  return (
    <View style={styles.screen}>
      <Text style={styles.label}>Paired with</Text>
      <Text style={styles.value}>{desktopName}</Text>
      <Text style={styles.label}>Connection</Text>
      <Text style={styles.value}>{status}</Text>
      {access ? <><Text style={styles.label}>This phone can</Text><Text style={styles.value}>{access === 'act' ? 'Read, send, steer and answer' : 'Read only'}</Text></> : null}
      <Text style={styles.muted}>Change what this phone can do, or revoke it, in Settings › Integrations › Phone on your computer.</Text>
      <Button label="Unpair this phone" kind="danger" onPress={onUnpair} />
    </View>
  );
}
const useStyles = themed(colors => StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background, padding: space.l, gap: space.s},
  label: {color: colors.muted, fontSize: font.small, marginTop: space.m},
  value: {color: colors.text, fontSize: font.body},
  muted: {color: colors.muted, fontSize: font.small, marginVertical: space.l},
}));
