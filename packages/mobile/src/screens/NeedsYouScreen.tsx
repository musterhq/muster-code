/** Everything waiting on the person across chats; approvals and questions are answered right here. */
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileConnection} from '../shared';
import {useAccess, useNeeds} from '../hooks';
import {ApprovalCard} from '../components/ApprovalCard';
import {QuestionCard} from '../components/QuestionCard';
import {colors, font, space} from '../theme';

export function NeedsYouScreen({connection, onOpen}: {connection: MobileConnection; onOpen?(chatId: string): void}) {
  const {needs, error} = useNeeds(connection);
  const canAct = useAccess(connection) === 'act';
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {needs && !needs.length ? <Text style={styles.muted}>Nothing needs you right now.</Text> : null}
      {(needs ?? []).map(need => (
        <View key={need.itemId} style={styles.entry}>
          <Pressable accessibilityRole="link" disabled={!onOpen} onPress={() => onOpen?.(need.chatId)}>
            <Text style={styles.chat}>{need.chatTitle}</Text>
          </Pressable>
          {need.kind === 'approval'
            ? <ApprovalCard connection={connection} itemId={need.itemId} {...(need.approval ? {approval: need.approval} : {})} canAct={canAct} fallback={need.summary} />
            : <QuestionCard connection={connection} itemId={need.itemId} questions={need.questions ?? []} canAct={canAct} />}
        </View>
      ))}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  content: {padding: space.l, gap: space.l},
  entry: {gap: space.s},
  chat: {color: colors.muted, fontSize: font.small, fontWeight: '600'},
  muted: {color: colors.muted, fontSize: font.body},
  error: {color: colors.danger},
});
