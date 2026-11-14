/** One timeline row. It follows only its own item in the store, so a streaming token re-renders this row and no other
 *  (MUS-SPEC-23-16A). Replies render as native Markdown; tool calls are one dim line; approvals and questions are cards. */
import {memo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {MobileConnection} from '../shared';
import type {TimelineStore} from '../timeline/store';
import {useTimelineItem} from '../timeline/useTimeline';
import {reportRender} from '../perf';
import {font, radius, space, themed, type} from '../theme';
import {ApprovalCard, offlineNote} from './ApprovalCard';
import {QuestionCard} from './QuestionCard';
import {Markdown} from './Markdown';

export const TimelineRow = memo(function TimelineRow({store, id, connection, canAct, offline}: {store: TimelineStore; id: string; connection: MobileConnection; canAct: boolean; offline?: string}) {
  const item = useTimelineItem(store, id);
  const styles = useStyles();
  reportRender('timeline-row', id);
  if (!item) return null;
  if (item.kind === 'approval') return <ApprovalCard connection={connection} itemId={item.id} {...(item.approval ? {approval: item.approval} : {})} {...(item.status ? {status: item.status} : {})} canAct={canAct} fallback={item.text} {...(offline ? {offline} : {})} />;
  if (item.kind === 'question') return <QuestionCard connection={connection} itemId={item.id} questions={item.questions ?? []} {...(item.status ? {status: item.status} : {})} canAct={canAct && !offline} {...(offline ? {note: offlineNote(offline)} : {})} />;
  if (item.kind === 'user') return <View style={styles.user}><Text style={styles.userText} selectable>{item.text}</Text></View>;
  if (item.kind === 'tool') return (
    <View style={styles.tool}>
      <View style={[styles.toolMark, item.status === 'failed' && styles.toolFailed]} />
      <Text style={styles.toolText} numberOfLines={2}>{item.text}{item.status && item.status !== 'completed' ? ` · ${item.status}` : ''}</Text>
    </View>
  );
  if (item.kind === 'notice') return <Text style={styles.notice}>{item.text}</Text>;
  if (item.kind === 'reasoning') return <Text style={styles.reasoning} numberOfLines={4}>{item.text}</Text>;
  return <View style={styles.assistant}><Markdown text={item.text} /></View>;
});
const useStyles = themed(c => StyleSheet.create({
  user: {alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: c.bubble, borderRadius: 18, borderBottomRightRadius: radius.s, paddingVertical: space.s, paddingHorizontal: space.m, marginVertical: space.xs},
  userText: {color: c.strong, ...type.body},
  assistant: {paddingVertical: space.xs},
  tool: {flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: 2},
  toolMark: {width: 12, height: 12, borderRadius: 3, backgroundColor: c.raised, borderWidth: StyleSheet.hairlineWidth, borderColor: c.control},
  toolFailed: {backgroundColor: c.danger},
  toolText: {flex: 1, color: c.muted, fontFamily: font.mono, ...type.caption},
  notice: {color: c.faint, ...type.label, fontStyle: 'italic'},
  reasoning: {color: c.faint, ...type.label},
}));
