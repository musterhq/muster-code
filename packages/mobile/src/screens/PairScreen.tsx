/** Pair this phone with a computer: scan the QR from Settings › Integrations › Phone, paste its link, or open a muster://pair
 *  link. One attempt at a time: while one is in flight (the desktop may already be waiting on its check code) the scanner is
 *  hidden and Pair does nothing, so a second attempt can't fail with "code already used" over the code the person needs. */
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {groupCheckCode, MobileError, NOT_A_PAIRING_LINK, parsePairingLink, type PairedRecord, type PairingLink} from '../shared';
import type {PairingStore} from '../connection/store';
import {Button} from '../components/Button';
import {errorText} from '../hooks';
import {font, radius, space, themed, type, useTheme} from '../theme';
import {Icon} from '../components/Icon';
import {PairedMoment} from './Moments';

export interface PairScreenProps {
  /** Runs the pairing handshake; `confirmed` settles when the desktop adds the phone after the owner compared check codes. */
  pairWith(link: PairingLink): Promise<{record: PairedRecord; checkCode: string; confirmed: Promise<void>}>;
  store: PairingStore;
  onPaired?(record: PairedRecord): void;
  /** Continue on the paired moment. */
  onDone?(): void;
  /** The camera scanner (not rendered in tests); it calls back with the scanned text. */
  scanner?: (onScan: (text: string) => void) => ReactNode;
  /** A link the app was opened with (muster://pair?…): filled in and paired at once. */
  initialLink?: string;
}

export function PairScreen({pairWith, store, onPaired, onDone, scanner, initialLink}: PairScreenProps) {
  const styles = useStyles(), colors = useTheme();
  const [text, setText] = useState(initialLink ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [checkCode, setCheckCode] = useState<string | null>(null);
  // State updates land after a render; a ref closes the gap between a scan and a press on the same frame.
  const inFlight = useRef(false);
  const pair = async (value: string) => {
    if (inFlight.current) return;
    let link: PairingLink;
    try { link = parsePairingLink(value); } catch (failure) { setError(failure instanceof MobileError ? failure.message : NOT_A_PAIRING_LINK); return; }
    inFlight.current = true;
    setError(null); setBusy(true);
    try {
      const {record, checkCode: code, confirmed} = await pairWith(link);
      // Nothing is stored until the owner confirms the same code on the computer.
      setCheckCode(code);
      try { await confirmed; } finally { setCheckCode(null); }
      await store.save(record);
      setPaired(record.desktopName);
      onPaired?.(record);
    } catch (failure) { setError(errorText(failure)); } finally { inFlight.current = false; setBusy(false); }
  };
  useEffect(() => { if (initialLink) void pair(initialLink); }, [initialLink]);
  if (paired) return <View style={styles.screen}><PairedMoment name={paired} onContinue={() => onDone?.()} /></View>;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title} accessibilityRole="header">Pair with your computer</Text>
      <View style={styles.card}>
        <Icon name="qr" size={26} color={colors.accent} stroke={1.8} />
        <Text style={styles.cardText}>On your computer, open Muster › Settings › Integrations › Phone and press Pair a phone. Scan the code, or paste its link. The link is end-to-end encrypted.</Text>
      </View>
      {scanner && !busy ? <View style={styles.scanner}>{scanner(value => { if (inFlight.current) return; setText(value); void pair(value); })}</View> : null}
      <TextInput style={styles.input} placeholder="Pairing link" placeholderTextColor={colors.muted} value={text} onChangeText={setText} editable={!busy} autoCapitalize="none" autoCorrect={false} />
      <Button label={busy ? 'Pairing…' : 'Pair'} kind="primary" disabled={busy} onPress={() => void pair(text)} />
      {checkCode ? <View style={styles.check} accessibilityLabel="Check code">
        <Text style={styles.checkTitle}>Check code</Text>
        <View style={styles.boxes} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{groupCheckCode(checkCode).split('').map((digit, index) => digit === ' ' ? <View key={index} style={styles.gap} /> : <View key={index} style={styles.box}><Text style={styles.digit}>{digit}</Text></View>)}</View>
        <Text style={styles.hidden}>{groupCheckCode(checkCode)}</Text>
        <Text style={styles.muted}>Make sure your computer shows the same code, then confirm it on your computer with Add phone. If the codes differ, reject it there.</Text>
      </View> : null}
      {error && !checkCode ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.muted}>A new phone can read your chats. To send, steer or answer from it, choose Can act for it on your computer.</Text>
    </ScrollView>
  );
}
const useStyles = themed(colors => StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  content: {padding: space.margin, gap: space.l, paddingBottom: 48},
  title: {color: colors.text, ...type.title1},
  card: {flexDirection: 'row', gap: 14, alignItems: 'flex-start', backgroundColor: colors.surface, borderRadius: radius.card, padding: space.l},
  cardText: {flex: 1, color: colors.text, ...type.subhead},
  muted: {color: colors.muted, ...type.footnote},
  scanner: {height: 280, borderRadius: radius.card, overflow: 'hidden', backgroundColor: colors.surface},
  input: {borderWidth: 1, borderColor: colors.control, borderRadius: radius.well, color: colors.text, paddingHorizontal: space.l, height: 50, ...type.body},
  check: {backgroundColor: colors.surface, borderRadius: radius.card, padding: space.l, gap: space.m, alignItems: 'center'},
  checkTitle: {color: colors.text, ...type.headline},
  boxes: {flexDirection: 'row', gap: 6},
  box: {width: 40, height: 52, borderRadius: 12, backgroundColor: colors.fill, alignItems: 'center', justifyContent: 'center'},
  gap: {width: 10},
  digit: {color: colors.text, fontSize: 28, lineHeight: 34, fontWeight: '700', fontFamily: font.mono},
  hidden: {position: 'absolute', opacity: 0, height: 1},
  error: {color: colors.danger, ...type.subhead},
}));
