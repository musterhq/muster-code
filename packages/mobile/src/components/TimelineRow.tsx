/** One timeline row. It follows only its own item in the store, so a streaming token re-renders this row and no other
 *  (MUS-SPEC-23-16A). Replies render as native Markdown at 17 on 26, the streaming one ending with the accent caret; the
 *  person's messages are bubbles; approvals and questions are cards. Tool steps fold into a WorkCapsule instead. */
import {memo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {MobileConnection} from '../shared';
import type {TimelineStore} from '../timeline/store';
import {useTimelineItem} from '../timeline/useTimeline';
import {reportRender} from '../perf';
import {space, themed, type} from '../theme';
import {ApprovalCard, offlineNote} from './ApprovalCard';
import {QuestionCard} from './QuestionCard';
import {Markdown} from './Markdown';
import {Caret} from './v3';

export const TimelineRow = memo(function TimelineRow({store, id, connection, canAct, offline, live = false}: {store: TimelineStore; id: string; connection: MobileConnection; canAct: boolean; offline?: string; /** The reply streaming now: it ends with the caret. */ live?: boolean}) {
  const item = useTimelineItem(store, id);
  const styles = useStyles();
  reportRender('timeline-row', id);
  if (!item) return null;
  if (item.kind === 'approval') return <ApprovalCard connection={connection} itemId={item.id} {...(item.approval ? {approval: item.approval} : {})} {...(item.status ? {status: item.status} : {})} canAct={canAct} fallback={item.text} createdAt={item.createdAt} {...(offline ? {offline} : {})} />;
  if (item.kind === 'question') return <QuestionCard connection={connection} itemId={item.id} questions={item.questions ?? []} {...(item.status ? {status: item.status} : {})} canAct={canAct && !offline} {...(offline ? {note: offlineNote(offline)} : {})} />;
  if (item.kind === 'user') return <View style={styles.user}><Text style={styles.userText} selectable>{item.text}</Text></View>;
  if (item.kind === 'tool' || item.kind === 'reasoning') return <Text style={styles.step} numberOfLines={2}>{item.text}</Text>;
  if (item.kind === 'notice') return <Text style={styles.notice}>{item.text}</Text>;
  return <View style={styles.assistant}><Markdown text={item.text} />{live ? <Caret /> : null}</View>;
});
const useStyles = themed(c => StyleSheet.create({
  user: {alignSelf: 'flex-end', maxWidth: '84%', backgroundColor: c.bubble, borderRadius: 22, paddingVertical: 11, paddingHorizontal: space.l, marginVertical: space.xs},
  userText: {color: c.text, fontSize: 17, lineHeight: 23},
  assistant: {paddingVertical: space.xs},
  step: {color: c.muted, ...type.subhead},
  notice: {color: c.muted, ...type.footnote, textAlign: 'center'},
}));
