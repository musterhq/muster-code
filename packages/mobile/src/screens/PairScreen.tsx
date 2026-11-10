/** Pair this phone with a computer: scan the QR from Settings › Integrations › Phone, or paste its link. */
import {useState, type ReactNode} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {groupCheckCode, MobileError, NOT_A_PAIRING_LINK, parsePairingLink, type PairedRecord, type PairingLink} from '../shared';
import type {PairingStore} from '../connection/store';
import {Button} from '../components/Button';
import {errorText} from '../hooks';
import {colors, font, radius, space} from '../theme';

export interface PairScreenProps {
  /** Runs the pairing handshake; `confirmed` settles when the desktop adds the phone after the owner compared check codes. */
  pairWith(link: PairingLink): Promise<{record: PairedRecord; checkCode: string; confirmed: Promise<void>}>;
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
  const [checkCode, setCheckCode] = useState<string | null>(null);
  const pair = async (value: string) => {
    if (busy) return;
    setError(null);
    let link: PairingLink;
    try { link = parsePairingLink(value); } catch (failure) { setError(failure instanceof MobileError ? failure.message : NOT_A_PAIRING_LINK); return; }
    setBusy(true);
    try {
      const {record, checkCode: code, confirmed} = await pairWith(link);
      // Nothing is stored until the owner confirms the same code on the computer.
      setCheckCode(code);
      try { await confirmed; } finally { setCheckCode(null); }
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
      {checkCode ? <View style={styles.check} accessibilityLabel="Check code">
        <Text style={styles.muted}>Check code</Text>
        <Text style={styles.code}>{groupCheckCode(checkCode)}</Text>
        <Text style={styles.muted}>Make sure your computer shows the same code, then confirm it on your computer with Add phone. If the codes differ, reject it there.</Text>
      </View> : null}
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
  check: {borderWidth: 1, borderColor: colors.border, borderRadius: radius.m, padding: space.m, gap: space.s, alignItems: 'center'},
  code: {color: colors.text, fontSize: 32, fontWeight: '700', letterSpacing: 4, fontVariant: ['tabular-nums']},
  error: {color: colors.danger, fontSize: font.small},
  success: {color: colors.success, fontSize: font.body},
});
