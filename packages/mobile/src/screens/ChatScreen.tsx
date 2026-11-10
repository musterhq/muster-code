/** One chat: its timeline streaming live, approval and question cards in place, and the composer (Send when idle, Steer
 *  while a turn runs, the same rule as the desktop's follow-up mode). */
import {useRef, useState, type ComponentRef} from 'react';
import {KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {MobileConnection} from '../shared';
import {errorText, READ_ONLY_NOTE, requestId, useAccess, useChat} from '../hooks';
import {Button} from '../components/Button';
import {TimelineRow} from '../components/TimelineRow';
import {colors, font, radius, space} from '../theme';

const BUSY = new Set(['running', 'stopping', 'waiting']);

export function ChatScreen({connection, chatId}: {connection: MobileConnection; chatId: string}) {
  const {chat, items, error} = useChat(connection, chatId);
  const access = useAccess(connection);
  const canAct = access === 'act';
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const steering = Boolean(chat && BUSY.has(chat.status));
  const submit = async () => {
    const text = draft.trim();
    if (!text || !canAct) return;
    setDraft(''); setSendError(null);
    try {
      if (steering) {
        const result = await connection.call('chat.steer', {id: chatId, text, requestId: requestId()});
        if (!result.steered) setSendError(result.reason ?? 'The turn ended first; send it again to start a new one.');
      } else await connection.call('chat.send', {id: chatId, text, requestId: requestId()});
    } catch (failure) { setDraft(text); setSendError(errorText(failure)); }
  };
  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{chat?.title ?? ''}</Text>
        {chat?.place ? <Text style={styles.muted}>{chat.place}</Text> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView ref={scroll} style={styles.list} contentContainerStyle={styles.content} onContentSizeChange={() => scroll.current?.scrollToEnd({animated: false})}>
        {items.map(item => <TimelineRow key={item.id} item={item} connection={connection} canAct={canAct} />)}
      </ScrollView>
      {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
      {!canAct ? <Text style={styles.readOnly}>{READ_ONLY_NOTE}</Text> : null}
      <View style={styles.composer}>
        <TextInput style={styles.input} placeholder="Message" placeholderTextColor={colors.muted} value={draft} onChangeText={setDraft} editable={canAct} multiline />
        <Button label={steering ? 'Steer' : 'Send'} kind="primary" disabled={!canAct || !draft.trim()} onPress={() => void submit()} />
      </View>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  header: {paddingHorizontal: space.l, paddingVertical: space.m, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border},
  title: {color: colors.text, fontSize: font.title, fontWeight: '600'},
  muted: {color: colors.muted, fontSize: font.small},
  list: {flex: 1},
  content: {padding: space.l, gap: space.m},
  error: {color: colors.danger, fontSize: font.small, paddingHorizontal: space.l},
  readOnly: {color: colors.muted, fontSize: font.small, paddingHorizontal: space.l, paddingTop: space.s},
  composer: {flexDirection: 'row', alignItems: 'flex-end', gap: space.s, padding: space.m, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border},
  input: {flex: 1, maxHeight: 140, borderWidth: 1, borderColor: colors.border, borderRadius: radius.m, color: colors.text, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: font.body},
});
