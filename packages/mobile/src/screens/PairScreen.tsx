/** Pair this phone with a computer: scan the QR from Settings › Integrations › Phone, or paste its link. */
import {useState, type ReactNode} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {MobileError, NOT_A_PAIRING_LINK, parsePairingLink, type PairedRecord, type PairingLink} from '../shared';
import type {PairingStore} from '../connection/store';
import {Button} from '../components/Button';
import {errorText} from '../hooks';
import {colors, font, radius, space} from '../theme';

export interface PairScreenProps {
  pairWith(link: PairingLink): Promise<PairedRecord>;
  store: PairingStore;
  onPaired?(record: PairedRecord): void;
  /** The camera scanner (not rendered in tests); it calls back with the scanned text. */
  scanner?: (onScan: (text: string) => void) => ReactNode;
}

export function PairScreen({pairWith, store, onPaired, scanner}: PairScreenProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const pair = async (value: string) => {
    if (busy) return;
    setError(null);
    let link: PairingLink;
    try { link = parsePairingLink(value); } catch (failure) { setError(failure instanceof MobileError ? failure.message : NOT_A_PAIRING_LINK); return; }
    setBusy(true);
    try {
      const record = await pairWith(link);
      await store.save(record);
      setPaired(record.desktopName);
      onPaired?.(record);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Pair with your computer</Text>
      <Text style={styles.muted}>On your computer, open Muster › Settings › Integrations › Phone and press Pair a phone. Scan the code, or paste its link.</Text>
      {scanner ? <View style={styles.scanner}>{scanner(value => { setText(value); void pair(value); })}</View> : null}
      <TextInput style={styles.input} placeholder="Pairing link" placeholderTextColor={colors.muted} value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false} />
      <Button label={busy ? 'Pairing…' : 'Pair'} kind="primary" disabled={busy} onPress={() => void pair(text)} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {paired ? <Text style={styles.success}>{`Paired with ${paired}`}</Text> : null}
      <Text style={styles.muted}>A new phone can read your chats. To send, steer or answer from it, choose Can act for it on your computer.</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background, padding: space.l, gap: space.m},
  title: {color: colors.text, fontSize: 22, fontWeight: '700'},
  muted: {color: colors.muted, fontSize: font.small, lineHeight: 18},
  scanner: {height: 260, borderRadius: radius.m, overflow: 'hidden', backgroundColor: colors.surface},
  input: {borderWidth: 1, borderColor: colors.border, borderRadius: radius.s, color: colors.text, padding: space.m, fontSize: font.body},
  error: {color: colors.danger, fontSize: font.small},
  success: {color: colors.success, fontSize: font.body},
});
