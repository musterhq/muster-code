/** Everything waiting on the person across chats; approvals and questions are answered right here. A phone that can act
 *  swipes an approval right to approve it or left to decline it. */
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileConnection, MobileNeed} from '../shared';
import {useAccess, useNeeds} from '../hooks';
import {ApprovalCard, useApprovalResponse} from '../components/ApprovalCard';
import {QuestionCard} from '../components/QuestionCard';
import {SwipeRow} from '../components/SwipeRow';
import {space, themed, type} from '../theme';

function ApprovalRow({connection, need, canAct}: {connection: MobileConnection; need: MobileNeed; canAct: boolean}) {
  const response = useApprovalResponse(connection, need.itemId);
  const card = <ApprovalCard connection={connection} itemId={need.itemId} {...(need.approval ? {approval: need.approval} : {})} canAct={canAct} fallback={need.summary} response={response} heading={need.chatTitle} />;
  if (!canAct || response.answered) return card;
  return (
    <SwipeRow testID={`swipe-${need.itemId}`} rightLabel="Approve" leftLabel="Decline" onRight={() => response.respond('accept')} onLeft={() => response.respond('decline')}>
      {card}
    </SwipeRow>
  );
}

export function NeedsYouScreen({connection, onOpen}: {connection: MobileConnection; onOpen?(chatId: string): void}) {
  const styles = useStyles();
  const {needs, error} = useNeeds(connection);
  const canAct = useAccess(connection) === 'act';
  return (
    <View style={styles.screen}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {/* The feed is short (what waits right now), so a plain scroll view; the chat and chat lists are virtualized. */}
      <ScrollView contentContainerStyle={styles.content}>
        {needs && !needs.length ? <Text style={styles.muted}>All clear. Nothing needs you right now.</Text> : null}
        {(needs ?? []).map(need => (
          <View key={need.itemId} style={styles.entry}>
            {need.kind === 'approval' ? <ApprovalRow connection={connection} need={need} canAct={canAct} /> : (
              <>
                <Text style={styles.chat} onPress={onOpen ? () => onOpen(need.chatId) : undefined} accessibilityRole={onOpen ? 'link' : undefined}>{need.chatTitle}</Text>
                <QuestionCard connection={connection} itemId={need.itemId} questions={need.questions ?? []} canAct={canAct} />
              </>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  content: {padding: space.m},
  entry: {gap: space.xs, paddingBottom: space.m},
  chat: {color: c.accent, ...type.label, fontWeight: '600'},
  muted: {color: c.muted, ...type.body, padding: space.l, textAlign: 'center'},
  error: {color: c.danger, ...type.label, padding: space.l},
}));
