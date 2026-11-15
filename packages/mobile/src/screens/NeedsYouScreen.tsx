/** Everything waiting on the person across chats; approvals and questions are answered right here. A phone that can act
 *  swipes an approval right to approve it or left to decline it. With several computers shown together each one has its
 *  own section; a computer that is offline shows what it last asked for, to answer once it is back (#326 phase 4). */
import {useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileConnection, MobileNeed} from '../shared';
import {useAccess, useNeeds} from '../hooks';
import {TAB_BAR_SPACE} from '../components/GlassTabBar';
import {LargeTitle} from './ChatsHome';
import {AllClear} from './Moments';
import {offlineOf} from '../offline/connection';
import {ApprovalCard, offlineNote, useApprovalResponse} from '../components/ApprovalCard';
import {QuestionCard} from '../components/QuestionCard';
import {SwipeRow} from '../components/SwipeRow';
import {space, themed, type} from '../theme';

export interface NeedsSource { id: string; name: string; connection: MobileConnection }

/** What the person answered here, for the receipts under All clear. */
type Answered = (line: string) => void;

function ApprovalRow({connection, need, canAct, offline, onAnswered}: {connection: MobileConnection; need: MobileNeed; canAct: boolean; offline?: string; onAnswered: Answered}) {
  const response = useApprovalResponse(connection, need.itemId);
  const told = useRef(false);
  useEffect(() => {
    if (!response.answered || told.current) return;
    told.current = true;
    onAnswered(`${response.answered === 'accept' ? 'Approved' : 'Declined'} ${need.approval?.command ?? need.summary}`);
  }, [response.answered]);
  const card = <ApprovalCard connection={connection} itemId={need.itemId} {...(need.approval ? {approval: need.approval} : {})} canAct={canAct} fallback={need.summary} response={response} heading={need.chatTitle} createdAt={need.createdAt} {...(offline ? {offline} : {})} />;
  if (!canAct || offline || response.answered) return card;
  return (
    <SwipeRow testID={`swipe-${need.itemId}`} rightLabel="Approve" leftLabel="Decline" onRight={() => response.respond('accept')} onLeft={() => response.respond('decline')}>
      {card}
    </SwipeRow>
  );
}

function NeedsSection({source, heading, needs, error, onOpen, onAnswered}: {source: NeedsSource; heading: boolean; needs: MobileNeed[] | null; error: string | null; onOpen?(chatId: string, computerId: string): void; onAnswered: Answered}) {
  const styles = useStyles();
  const {connection} = source;
  const canAct = useAccess(connection) === 'act';
  const offline = offlineOf(connection) ? source.name : undefined;
  if (!needs?.length && !error && !heading) return null;
  return (
    <View style={styles.section}>
      {heading ? <Text style={styles.computer} accessibilityRole="header">{source.name}{offline ? ' · offline' : ''}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {heading && needs && !needs.length ? <Text style={styles.muted}>Nothing waiting.</Text> : null}
      {(needs ?? []).map(need => (
        <View key={need.itemId} style={styles.entry}>
          {need.kind === 'approval' ? <ApprovalRow connection={connection} need={need} canAct={canAct} onAnswered={onAnswered} {...(offline ? {offline} : {})} /> : (
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

/** Every source's needs, live. */
function useAllNeeds(sources: NeedsSource[]) {
  return sources.map(source => ({source, ...useNeeds(source.connection)}));
}
function Sources({sources, children}: {sources: NeedsSource[]; children(all: ReturnType<typeof useAllNeeds>): React.ReactNode}) {
  return <>{children(useAllNeeds(sources))}</>;
}

/** Needs you (v3): one queue for every computer under a large title that counts what waits, one decision per card. Answering
 *  the last one shows the All clear moment with what was just answered (MUS-SPEC-23-24G). */
export function NeedsYouScreen({connection, sources: given, onOpen}: {connection?: MobileConnection; sources?: NeedsSource[]; onOpen?(chatId: string, computerId: string): void}) {
  const styles = useStyles();
  const sources = given ?? (connection ? [{id: '', name: connection.desktopName, connection}] : []);
  const [answered, setAnswered] = useState<string[]>([]);
  const onAnswered: Answered = line => setAnswered(current => [line, ...current].slice(0, 5));
  // The hooks run per source; the source list only changes with the computers, so it is keyed on their ids.
  return (
    <Sources key={sources.map(source => source.id).join(',')} sources={sources}>{all => {
      const loaded = all.every(entry => entry.needs);
      const waiting = all.reduce((sum, entry) => sum + (entry.needs?.length ?? 0), 0);
      return (
        <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
          <LargeTitle title="Needs you"><Text style={styles.count}>{!loaded ? 'Loading…' : waiting ? `${waiting} waiting` : 'Nothing waiting'}{sources.length > 1 ? <Text style={styles.countSub}> · all computers</Text> : null}</Text></LargeTitle>
          <View style={styles.cards}>
            {all.map(({source, needs, error}) => <NeedsSection key={source.id} source={source} heading={sources.length > 1 && Boolean(needs?.length)} needs={needs} error={error} onAnswered={onAnswered} {...(onOpen ? {onOpen} : {})} />)}
          </View>
          {loaded && !waiting ? <AllClear answered={answered} celebrate={answered.length > 0} /> : null}
        </ScrollView>
      );
    }}</Sources>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  content: {paddingBottom: TAB_BAR_SPACE},
  count: {color: c.text, ...type.subhead, fontWeight: '600'},
  countSub: {color: c.muted, fontWeight: '400'},
  cards: {paddingHorizontal: space.card, gap: 14},
  section: {gap: 14},
  computer: {color: c.muted, ...type.footnote, fontWeight: '500', paddingHorizontal: space.xs, paddingTop: space.s},
  entry: {gap: space.xs},
  chat: {color: c.accent, ...type.footnote, fontWeight: '600', paddingHorizontal: space.xs},
  muted: {color: c.muted, ...type.subhead, paddingHorizontal: space.xs},
  error: {color: c.danger, ...type.footnote, padding: space.l},
}));
