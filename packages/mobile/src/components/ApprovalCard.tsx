/** An approval request, answered in place: one request only (approving for the whole session stays on the computer). A tap
 *  shows the card working and ignores more taps, so nothing is sent twice; the answer collapses the card with a haptic. */
import {useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Animated from 'react-native-reanimated';
import type {MobileApproval, MobileConnection} from '../shared';
import {errorText} from '../hooks';
import {haptics} from '../haptics';
import {rowLayout} from '../motion';
import {radius, size, space, themed, type, useTheme} from '../theme';
import {ago} from '../time';
import {Icon} from './Icon';
import {Button} from './Button';

export type Decision = 'accept' | 'decline';
export interface ApprovalResponse { sending: Decision | null; answered: Decision | null; error: string | null; respond(decision: Decision): void }
/** Answers one approval at most once at a time: a second tap or swipe while it is sent, or after it was answered, does nothing. */
export function useApprovalResponse(connection: MobileConnection, itemId: string): ApprovalResponse {
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<Decision | null>(null);
  const [answered, setAnswered] = useState<Decision | null>(null);
  const busy = useRef(false);
  const respond = (decision: Decision) => {
    if (busy.current || answered) return;
    busy.current = true;
    setError(null); setSending(decision);
    connection.call('approval.respond', {itemId, decision}).then(() => {
      setAnswered(decision);
      if (decision === 'accept') haptics.success(); else haptics.warning();
    }, failure => setError(errorText(failure))).finally(() => { busy.current = false; setSending(null); });
  };
  return {sending, answered, error, respond};
}

/** Approvals are never queued offline: they wait for the computer. */
export const offlineNote = (computer: string): string => `${computer} is offline. You can answer this when ${computer} is back.`;

const QUESTION: Record<MobileApproval['kind'], string> = {command: 'Run this command?', fileChange: 'Change these files?', mcp: 'Use this tool?'};

/** An approval in the v3 anatomy (MUS-SPEC-23-24F): the question is the title next to an amber hand, then the command in a
 *  code well, one line of why, and Approve as the one filled action (Decline is plain). Answered, it folds into a receipt.
 *  A watch-only phone keeps the question and command but is told where to answer instead of being shown buttons.
 *  `response`: pass one when something else (a swipe) answers this card too; otherwise the card has its own. `heading` names the
 *  chat in Needs you. */
export function ApprovalCard({connection, itemId, approval, status, canAct, fallback, response, heading, offline, createdAt}: {connection: MobileConnection; itemId: string; approval?: MobileApproval; status?: string; canAct: boolean; fallback: string; response?: ApprovalResponse; heading?: string; offline?: string; createdAt?: string}) {
  const styles = useStyles(), c = useTheme();
  const own = useApprovalResponse(connection, itemId);
  const {sending, answered, error, respond} = response ?? own;
  const settled = answered ? (answered === 'accept' ? 'approved' : 'declined') : status && status !== 'pending' ? status : null;
  const what = approval?.command ?? (approval?.tool ? `${approval.server ? `${approval.server} › ` : ''}${approval.tool}` : approval?.files?.length ? approval.files.join(', ') : fallback);
  if (settled) {
    const approved = settled === 'approved' || settled === 'approved-session' || settled === 'accepted' || settled === 'completed';
    const word = approved ? 'Approved' : settled === 'declined' ? 'Declined' : settled;
    return (
      <Animated.View layout={rowLayout} style={styles.receipt} accessibilityLabel={`${word} ${what}`}>
        <Icon name={approved ? 'check' : 'x'} size={18} color={approved ? c.success : c.danger} stroke={2.4} />
        <Text style={styles.receiptText} numberOfLines={1}><Text style={styles.receiptWord}>{word}</Text>{` · ${what}`}</Text>
      </Animated.View>
    );
  }
  const meta = [heading ?? 'Needs your approval', createdAt ? agoWords(createdAt) : null].filter(Boolean).join(' · ');
  const code = approval?.command ? approval.command.split('\n') : approval?.tool ? [what] : approval?.files?.length ? approval.files : [];
  return (
    <Animated.View layout={rowLayout} style={styles.card}>
      <View style={styles.head}>
        <View style={styles.tile}><Icon name="hand" size={20} color={c.warning} stroke={2.1} /></View>
        <View style={styles.headText}>
          <Text style={styles.title}>{QUESTION[approval?.kind ?? 'command']}</Text>
          <Text style={styles.meta} numberOfLines={1}>{meta}</Text>
        </View>
      </View>
      {code.length ? <View style={styles.well}>{code.map((line, index) => (
        <View key={index} style={styles.codeLine}>{approval?.kind === 'command' ? <Text style={styles.prompt}>$</Text> : null}<Text style={styles.code} selectable>{line}</Text></View>
      ))}</View> : <Text style={styles.why}>{fallback}</Text>}
      {approval?.reason ? <Text style={styles.why} numberOfLines={3}>{approval.reason}</Text> : null}
      {offline ? <Text style={styles.note}>{offlineNote(offline)}</Text> : canAct ? (
        <>
          <View style={styles.actions}>
            <Button label="Decline" grow disabled={Boolean(sending)} busy={sending === 'decline'} onPress={() => respond('decline')} />
            <Button label="Approve" kind="primary" grow disabled={Boolean(sending)} busy={sending === 'accept'} onPress={() => respond('accept')} />
          </View>
          <Text style={styles.quiet}>Approving for the whole chat is a desktop setting</Text>
        </>
      ) : <Text style={styles.note}>{`Watch only. Answer this on ${connection.desktopName}, or let this phone act in Settings › Integrations › Phone there.`}</Text>}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Animated.View>
  );
}
const agoWords = (iso: string) => { const at = ago(iso); return at === 'now' ? 'just now' : `${at} ago`; };
const useStyles = themed(c => StyleSheet.create({
  card: {backgroundColor: c.surface, borderRadius: radius.card, padding: space.l, gap: 14},
  head: {flexDirection: 'row', gap: space.m, alignItems: 'flex-start'},
  tile: {width: size.glyph, height: size.glyph, borderRadius: size.glyph / 2, backgroundColor: c.warningTint, alignItems: 'center', justifyContent: 'center'},
  headText: {flex: 1, gap: 2},
  title: {color: c.text, ...type.headline},
  meta: {color: c.muted, ...type.footnote},
  well: {backgroundColor: c.code, borderRadius: radius.well, paddingHorizontal: space.l, paddingVertical: space.m, gap: 2},
  codeLine: {flexDirection: 'row', gap: space.s},
  prompt: {color: c.faint, ...type.codeBlock},
  code: {flex: 1, color: c.text, ...type.codeBlock},
  why: {color: c.muted, ...type.subhead},
  actions: {flexDirection: 'row', gap: space.m},
  quiet: {color: c.faint, ...type.footnote, textAlign: 'center'},
  note: {color: c.muted, ...type.subhead},
  error: {color: c.danger, ...type.footnote},
  receipt: {flexDirection: 'row', alignItems: 'center', gap: space.s, backgroundColor: c.surface, borderRadius: 22, height: 44, paddingHorizontal: 14, alignSelf: 'flex-start', maxWidth: '100%'},
  receiptText: {color: c.muted, ...type.subhead, flexShrink: 1},
  receiptWord: {color: c.text, fontWeight: '600'},
}));
