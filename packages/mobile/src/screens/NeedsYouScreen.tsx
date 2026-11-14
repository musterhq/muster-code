/** Everything waiting on the person across chats; approvals and questions are answered right here. A phone that can act
 *  swipes an approval right to approve it or left to decline it. With several computers shown together each one has its
 *  own section; a computer that is offline shows what it last asked for, to answer once it is back (#326 phase 4). */
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileConnection, MobileNeed} from '../shared';
import {useAccess, useNeeds} from '../hooks';
import {offlineOf} from '../offline/connection';
import {ApprovalCard, offlineNote, useApprovalResponse} from '../components/ApprovalCard';
import {QuestionCard} from '../components/QuestionCard';
import {SwipeRow} from '../components/SwipeRow';
import {space, themed, type} from '../theme';

export interface NeedsSource { id: string; name: string; connection: MobileConnection }

function ApprovalRow({connection, need, canAct, offline}: {connection: MobileConnection; need: MobileNeed; canAct: boolean; offline?: string}) {
  const response = useApprovalResponse(connection, need.itemId);
  const card = <ApprovalCard connection={connection} itemId={need.itemId} {...(need.approval ? {approval: need.approval} : {})} canAct={canAct} fallback={need.summary} response={response} heading={need.chatTitle} {...(offline ? {offline} : {})} />;
  if (!canAct || offline || response.answered) return card;
  return (
    <SwipeRow testID={`swipe-${need.itemId}`} rightLabel="Approve" leftLabel="Decline" onRight={() => response.respond('accept')} onLeft={() => response.respond('decline')}>
      {card}
    </SwipeRow>
  );
}

function NeedsSection({source, heading, onOpen}: {source: NeedsSource; heading: boolean; onOpen?(chatId: string, computerId: string): void}) {
  const styles = useStyles();
  const {connection} = source;
  const {needs, error} = useNeeds(connection);
  const canAct = useAccess(connection) === 'act';
  const offline = offlineOf(connection) ? source.name : undefined;
  return (
    <View style={styles.section}>
      {heading ? <Text style={styles.computer} accessibilityRole="header">{source.name}{offline ? ' · offline' : ''}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {needs && !needs.length ? <Text style={styles.muted}>{heading ? 'Nothing waiting.' : 'All clear. Nothing needs you right now.'}</Text> : null}
      {(needs ?? []).map(need => (
        <View key={need.itemId} style={styles.entry}>
          {need.kind === 'approval' ? <ApprovalRow connection={connection} need={need} canAct={canAct} {...(offline ? {offline} : {})} /> : (
            <>
              <Text style={styles.chat} onPress={onOpen ? () => onOpen(need.chatId, source.id) : undefined} accessibilityRole={onOpen ? 'link' : undefined}>{need.chatTitle}</Text>
              <QuestionCard connection={connection} itemId={need.itemId} questions={need.questions ?? []} canAct={canAct && !offline} {...(offline ? {note: offlineNote(offline)} : {})} />
            </>
          )}
        </View>
      ))}
    </View>
  );
}

export function NeedsYouScreen({connection, sources: given, onOpen}: {connection?: MobileConnection; sources?: NeedsSource[]; onOpen?(chatId: string, computerId: string): void}) {
  const styles = useStyles();
  const sources = given ?? (connection ? [{id: '', name: connection.desktopName, connection}] : []);
  return (
    <View style={styles.screen}>
      {/* The feed is short (what waits right now), so a plain scroll view; the chat and chat lists are virtualized. */}
      <ScrollView contentContainerStyle={styles.content}>
        {sources.map(source => <NeedsSection key={source.id} source={source} heading={sources.length > 1} {...(onOpen ? {onOpen} : {})} />)}
      </ScrollView>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  content: {padding: space.m},
  section: {paddingBottom: space.s},
  computer: {color: c.muted, ...type.caption, fontWeight: '600', textTransform: 'uppercase', paddingVertical: space.s},
  entry: {gap: space.xs, paddingBottom: space.m},
  chat: {color: c.accent, ...type.label, fontWeight: '600'},
  muted: {color: c.muted, ...type.body, padding: space.l, textAlign: 'center'},
  error: {color: c.danger, ...type.label, padding: space.l},
}));
