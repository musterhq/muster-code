/** One timeline item. Phase 1 shows text with code fences in monospace; rich rendering (Markdown, diffs, Mermaid, maths,
 *  charts, pages) is phase 4 (docs/mobile/DESIGN.md §5.4). */
import {StyleSheet, Text, View} from 'react-native';
import type {MobileConnection, MobileItem} from '../shared';
import {colors, font, radius, space} from '../theme';
import {ApprovalCard} from './ApprovalCard';
import {QuestionCard} from './QuestionCard';

/** Splits ``` fences out so code reads in monospace. */
export function textParts(text: string): Array<{code: boolean; text: string}> {
  return text.split(/```[^\n]*\n?/).map((part, index) => ({code: index % 2 === 1, text: part.replace(/\n$/, '')})).filter(part => part.text.length > 0);
}

export function TimelineRow({item, connection, canAct}: {item: MobileItem; connection: MobileConnection; canAct: boolean}) {
  if (item.kind === 'approval') return <ApprovalCard connection={connection} itemId={item.id} {...(item.approval ? {approval: item.approval} : {})} {...(item.status ? {status: item.status} : {})} canAct={canAct} fallback={item.text} />;
  if (item.kind === 'question') return <QuestionCard connection={connection} itemId={item.id} questions={item.questions ?? []} {...(item.status ? {status: item.status} : {})} canAct={canAct} />;
  if (item.kind === 'user') return <View style={styles.user}><Text style={styles.text}>{item.text}</Text></View>;
  if (item.kind === 'tool') return <Text style={styles.tool} numberOfLines={2}>{item.text}{item.status && item.status !== 'completed' ? ` · ${item.status}` : ''}</Text>;
  if (item.kind === 'notice') return <Text style={styles.notice}>{item.text}</Text>;
  if (item.kind === 'reasoning') return <Text style={styles.reasoning} numberOfLines={4}>{item.text}</Text>;
  const parts = textParts(item.text);
  if (parts.length === 1 && !parts[0]!.code) return <Text style={styles.text} selectable>{item.text}</Text>;
  return (
    <View style={styles.assistant}>
      {parts.map((part, index) => <Text key={index} selectable style={part.code ? styles.code : styles.text}>{part.text}</Text>)}
    </View>
  );
}
const styles = StyleSheet.create({
  user: {alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: colors.raised, borderRadius: radius.l, paddingVertical: space.s, paddingHorizontal: space.m},
  assistant: {gap: space.s},
  text: {color: colors.text, fontSize: font.body, lineHeight: 21},
  code: {color: colors.text, fontFamily: font.mono, fontSize: font.small, backgroundColor: colors.surface, padding: space.s, borderRadius: radius.s},
  tool: {color: colors.muted, fontFamily: font.mono, fontSize: font.small},
  notice: {color: colors.muted, fontSize: font.small, fontStyle: 'italic'},
  reasoning: {color: colors.muted, fontSize: font.small},
});
