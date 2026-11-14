/** This phone's computers (#326 phase 4): each with how it is connected and what this phone may do there, and Unpair, which
 *  forgets that computer's keys and everything cached from it on this phone. Pair another computer adds one. */
import {StyleSheet, Text, View} from 'react-native';
import type {ComputerView} from '../connection/computers';
import {Button} from '../components/Button';
import {StatusDot} from '../components/ComputerPill';
import {computerStatus} from '../components/ComputerSwitcher';
import {space, themed, type} from '../theme';

export function SettingsScreen({computers, onUnpair, onPair}: {computers: ComputerView[]; onUnpair(id: string): void; onPair(): void}) {
  const styles = useStyles();
  return (
    <View style={styles.screen}>
      <Text style={styles.label}>Computers</Text>
      {computers.map(view => (
        <View key={view.id} style={styles.card}>
          <View style={styles.line}><StatusDot path={view.path} /><Text style={styles.name}>{view.name}</Text></View>
          <Text style={styles.muted}>{computerStatus(view)}</Text>
          {view.access ? <Text style={styles.muted}>{view.access === 'act' ? 'This phone can read, send, steer and answer' : 'This phone can read only'}</Text> : null}
          <Button label={`Unpair ${view.name}`} kind="danger" onPress={() => onUnpair(view.id)} />
        </View>
      ))}
      <Button label="Pair another computer" onPress={onPair} />
      <Text style={styles.muted}>Change what this phone can do on a computer, or revoke it, in Settings › Integrations › Phone on that computer. Unpairing here forgets its keys and the chats this phone saved from it.</Text>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background, padding: space.l, gap: space.m},
  label: {color: c.muted, ...type.caption, fontWeight: '600', textTransform: 'uppercase'},
  card: {backgroundColor: c.surface, borderRadius: 14, padding: space.m, gap: space.s},
  line: {flexDirection: 'row', alignItems: 'center', gap: space.s},
  name: {color: c.strong, ...type.footnote, fontWeight: '600'},
  muted: {color: c.muted, ...type.label},
}));
