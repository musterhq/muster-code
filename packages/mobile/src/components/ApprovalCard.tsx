/** An approval request, answered in place: one request only (approving for the whole session stays on the computer). A tap
 *  shows the card working and ignores more taps, so nothing is sent twice; the answer collapses the card with a haptic. */
import {useRef, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Animated from 'react-native-reanimated';
import type {MobileApproval, MobileConnection} from '../shared';
import {errorText, READ_ONLY_NOTE} from '../hooks';
import {haptics} from '../haptics';
import {rowLayout} from '../motion';
import {font, space, themed, type} from '../theme';
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

/** `response`: pass one when something else (a swipe) answers this card too; otherwise the card has its own. `heading` names the
 *  chat in Needs you. */
export function ApprovalCard({connection, itemId, approval, status, canAct, fallback, response, heading, offline}: {connection: MobileConnection; itemId: string; approval?: MobileApproval; status?: string; canAct: boolean; fallback: string; response?: ApprovalResponse; heading?: string; offline?: string}) {
  const styles = useStyles();
  const own = useApprovalResponse(connection, itemId);
  const {sending, answered, error, respond} = response ?? own;
  const settled = answered ? (answered === 'accept' ? 'approved' : 'declined') : status && status !== 'pending' ? status : null;
  const title = approval?.kind === 'fileChange' ? 'Change files' : approval?.kind === 'mcp' ? 'Use a tool' : 'Run a command';
  return (
    <Animated.View layout={rowLayout} style={styles.card}>
      <Text style={[styles.title, settled && styles.titleDone]}>{settled ? title : heading ? `Approval · ${heading}` : 'Approval needed'}</Text>
      {approval?.command ? <Text style={styles.code}>{approval.command}</Text> : null}
      {approval?.tool ? <Text style={styles.code}>{approval.server ? `${approval.server} › ` : ''}{approval.tool}</Text> : null}
      {approval?.files?.length ? <Text style={styles.code}>{approval.files.join('\n')}</Text> : null}
      {!approval?.command && !approval?.tool && !approval?.files?.length ? <Text style={styles.body}>{fallback}</Text> : null}
      {approval?.reason && !settled ? <Text style={styles.muted}>{approval.reason}</Text> : null}
      {settled ? <Text style={styles.muted}>{settled === 'approved' || settled === 'approved-session' ? 'Approved' : settled === 'declined' ? 'Declined' : settled}</Text>
        : offline ? <Text style={styles.muted}>{offlineNote(offline)}</Text> : canAct ? (
          <View style={styles.row}>
            <View style={styles.grow}><Button label="Decline" disabled={Boolean(sending)} busy={sending === 'decline'} onPress={() => respond('decline')} /></View>
            <View style={styles.grow}><Button label="Approve" kind="primary" disabled={Boolean(sending)} busy={sending === 'accept'} onPress={() => respond('accept')} /></View>
          </View>
        ) : <Text style={styles.muted}>{READ_ONLY_NOTE}</Text>}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Animated.View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  card: {backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: space.m, gap: space.s},
  title: {color: c.warning, ...type.label, fontWeight: '600'},
  titleDone: {color: c.muted},
  code: {color: c.text, fontFamily: font.mono, ...type.label},
  body: {color: c.text, ...type.body},
  muted: {color: c.muted, ...type.label},
  error: {color: c.danger, ...type.label},
  row: {flexDirection: 'row', gap: space.s, marginTop: space.xs},
  grow: {flex: 1},
}));
