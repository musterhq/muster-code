/** One chat: its timeline streaming live, approval and question cards in place, and the composer (Send when idle, Steer
 *  while a turn runs, the same rule as the desktop's follow-up mode). */
import {useRef, useState, type ComponentRef} from 'react';
import {KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {sha256} from '@noble/hashes/sha2.js';
import {uploadAttachment, type MobileAttachment, type MobileConnection} from '../shared';
import type {AttachSource, PickAttachment} from '../attachments';
import {errorText, READ_ONLY_NOTE, requestId, useAccess, useChat} from '../hooks';
import {Button} from '../components/Button';
import {TimelineRow} from '../components/TimelineRow';
import {colors, font, radius, space} from '../theme';

const BUSY = new Set(['running', 'stopping', 'waiting']);

/** A file in the composer: uploading (with how much has arrived) or ready to send. */
interface Draft { key: string; name: string; size: number; sent: number; attachment: MobileAttachment | null }
const SOURCES: Array<[AttachSource, string]> = [['photo', 'Photo'], ['camera', 'Camera'], ['file', 'File']];

export function ChatScreen({connection, chatId, pickAttachment}: {connection: MobileConnection; chatId: string; pickAttachment?: PickAttachment}) {
  const {chat, items, error} = useChat(connection, chatId);
  const access = useAccess(connection);
  const canAct = access === 'act';
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [files, setFiles] = useState<Draft[]>([]);
  const [menu, setMenu] = useState(false);
  const steering = Boolean(chat && BUSY.has(chat.status));
  const uploading = files.some(file => !file.attachment);
  const update = (key: string, change: Partial<Draft>) => setFiles(current => current.map(file => file.key === key ? {...file, ...change} : file));
  const attach = async (source: AttachSource) => {
    setMenu(false); setSendError(null);
    if (!pickAttachment) return;
    const key = requestId();
    try {
      const picked = await pickAttachment(source);
      if (!picked) return;
      setFiles(current => [...current, {key, name: picked.name, size: picked.bytes.length, sent: 0, attachment: null}]);
      const attachment = await uploadAttachment(connection, {chatId, name: picked.name, mime: picked.mime, bytes: picked.bytes, sha256, onProgress: sent => update(key, {sent})});
      update(key, {attachment, sent: attachment.size});
    } catch (failure) { setFiles(current => current.filter(file => file.key !== key)); setSendError(errorText(failure)); }
  };
  const remove = (file: Draft) => {
    setFiles(current => current.filter(entry => entry.key !== file.key));
    if (file.attachment) void connection.call('upload.discard', {chatId, attachmentId: file.attachment.id}).catch(() => undefined);
  };
  const submit = async () => {
    const text = draft.trim();
    if (!text || !canAct || uploading) return;
    // Files go with a new message; a running turn can't take them (the desktop's rule), so Steer waits for the turn to end.
    if (steering && files.length) return;
    const attached = files;
    setDraft(''); setFiles([]); setSendError(null);
    try {
      if (steering) {
        const result = await connection.call('chat.steer', {id: chatId, text, requestId: requestId()});
        if (!result.steered) setSendError(result.reason ?? 'The turn ended first; send it again to start a new one.');
      } else await connection.call('chat.send', {id: chatId, text, requestId: requestId(), ...(attached.length ? {attachmentIds: attached.map(file => file.attachment!.id)} : {})});
    } catch (failure) { setDraft(text); setFiles(attached); setSendError(errorText(failure)); }
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
      {files.length ? <View style={styles.files}>
        {files.map(file => <View key={file.key} style={styles.file}>
          <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
          {file.attachment ? null : <Text style={styles.muted}>{`${Math.floor(file.sent * 100 / Math.max(1, file.size))}%`}</Text>}
          <Text accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} style={styles.remove} onPress={() => remove(file)}>×</Text>
        </View>)}
      </View> : null}
      {steering && files.length ? <Text style={styles.readOnly}>Photos and files go with your next message, once this turn ends.</Text> : null}
      {menu ? <View style={styles.menu}>{SOURCES.map(([source, label]) => <Button key={source} label={label} onPress={() => void attach(source)} />)}</View> : null}
      <View style={styles.composer}>
        {pickAttachment ? <Pressable accessibilityRole="button" accessibilityLabel="Attach" disabled={!canAct} onPress={() => setMenu(open => !open)} style={[styles.attach, !canAct && styles.dim]}>
          <Text style={styles.attachLabel}>+</Text>
        </Pressable> : null}
        <TextInput style={styles.input} placeholder="Message" placeholderTextColor={colors.muted} value={draft} onChangeText={setDraft} editable={canAct} multiline />
        <Button label={steering ? 'Steer' : 'Send'} kind="primary" disabled={!canAct || !draft.trim() || uploading || (steering && files.length > 0)} onPress={() => void submit()} />
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
  files: {flexDirection: 'row', flexWrap: 'wrap', gap: space.s, paddingHorizontal: space.m, paddingTop: space.s},
  file: {flexDirection: 'row', alignItems: 'center', gap: space.s, maxWidth: '100%', borderWidth: 1, borderColor: colors.control, borderRadius: radius.s, paddingHorizontal: space.s, paddingVertical: 2},
  fileName: {color: colors.text, fontSize: font.small, flexShrink: 1},
  remove: {color: colors.text, fontSize: font.body, paddingHorizontal: space.xs},
  menu: {flexDirection: 'row', gap: space.s, paddingHorizontal: space.m, paddingTop: space.s},
  attach: {width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.control, alignItems: 'center', justifyContent: 'center'},
  attachLabel: {color: colors.text, fontSize: 20, lineHeight: 22},
  dim: {opacity: 0.5},
  input: {flex: 1, maxHeight: 140, borderWidth: 1, borderColor: colors.border, borderRadius: radius.m, color: colors.text, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: font.body},
});
