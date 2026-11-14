/** An approval request, answered in place: one request only (approving for the whole session stays on the computer). */
import {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {MobileApproval, MobileConnection} from '../shared';
import {errorText, READ_ONLY_NOTE} from '../hooks';
import {colors, font, radius, space} from '../theme';
import {Button} from './Button';

export function ApprovalCard({connection, itemId, approval, status, canAct, fallback}: {connection: MobileConnection; itemId: string; approval?: MobileApproval; status?: string; canAct: boolean; fallback: string}) {
  const [error, setError] = useState<string | null>(null);
  const pending = !status || status === 'pending';
  const respond = (decision: 'accept' | 'decline') => { setError(null); connection.call('approval.respond', {itemId, decision}).catch(failure => setError(errorText(failure))); };
  const title = approval?.kind === 'fileChange' ? 'Change files' : approval?.kind === 'mcp' ? 'Use a tool' : 'Run a command';
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {approval?.command ? <Text style={styles.code}>{approval.command}</Text> : null}
      {approval?.tool ? <Text style={styles.code}>{approval.server ? `${approval.server} › ` : ''}{approval.tool}</Text> : null}
      {approval?.files?.length ? <Text style={styles.code}>{approval.files.join('\n')}</Text> : null}
      {!approval?.command && !approval?.tool && !approval?.files?.length ? <Text style={styles.body}>{fallback}</Text> : null}
      {approval?.reason ? <Text style={styles.muted}>{approval.reason}</Text> : null}
      {!pending ? <Text style={styles.muted}>{status === 'approved' || status === 'approved-session' ? 'Approved' : status === 'declined' ? 'Declined' : status}</Text>
        : canAct ? (
          <View style={styles.row}>
            <Button label="Approve" kind="primary" onPress={() => respond('accept')} />
            <Button label="Decline" onPress={() => respond('decline')} />
          </View>
        ) : <Text style={styles.muted}>{READ_ONLY_NOTE}</Text>}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {backgroundColor: colors.surface, borderRadius: radius.m, borderWidth: 1, borderColor: colors.warning, padding: space.m, gap: space.s},
  title: {color: colors.text, fontWeight: '600', fontSize: font.body},
  code: {color: colors.text, fontFamily: font.mono, fontSize: font.small},
  body: {color: colors.text, fontSize: font.body},
  muted: {color: colors.muted, fontSize: font.small},
  error: {color: colors.danger, fontSize: font.small},
  row: {flexDirection: 'row', gap: space.s},
});
