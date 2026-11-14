/** One chat: its timeline streaming live in a virtualized list, approval and question cards in place, and the composer (Send
 *  when idle, Steer while a turn runs, the same rule as the desktop's follow-up mode). The composer rides the keyboard. */
import {useState, type ReactNode} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {KeyboardStickyView} from 'react-native-keyboard-controller';
import {sha256} from '@noble/hashes/sha2.js';
import {uploadAttachment, type MobileAttachment, type MobileChat, type MobileConnection} from '../shared';
import type {AttachSource, PickAttachment} from '../attachments';
import {errorText, READ_ONLY_NOTE, requestId, useAccess, useChat} from '../hooks';
import {haptics} from '../haptics';
import {Button} from '../components/Button';
import {ChatTimeline} from '../components/ChatTimeline';
import {space, themed, touch, type, useTheme} from '../theme';

const BUSY = new Set(['running', 'stopping', 'waiting']);

/** A file in the composer: uploading (with how much has arrived) or ready to send. */
interface Draft { key: string; name: string; size: number; sent: number; attachment: MobileAttachment | null }
const SOURCES: Array<[AttachSource, string]> = [['photo', 'Photo'], ['camera', 'Camera'], ['file', 'File']];

/** `header`: how the chat's title is shown. A stack route passes one that sets its native header (one bar, no second header
 *  in the body); a tablet pane or a test leaves it out and the title shows at the top of the screen. */
export function ChatScreen({connection, chatId, pickAttachment, header}: {connection: MobileConnection; chatId: string; pickAttachment?: PickAttachment; header?: (chat: MobileChat | null) => ReactNode}) {
  const {chat, store, error} = useChat(connection, chatId);
  const styles = useStyles(), c = useTheme();
  const access = useAccess(connection);
  const canAct = access === 'act';
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
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
    haptics.tap();
    try {
      if (steering) {
        const result = await connection.call('chat.steer', {id: chatId, text, requestId: requestId()});
        if (!result.steered) setSendError(result.reason ?? 'The turn ended first; send it again to start a new one.');
      } else await connection.call('chat.send', {id: chatId, text, requestId: requestId(), ...(attached.length ? {attachmentIds: attached.map(file => file.attachment!.id)} : {})});
    } catch (failure) { setDraft(text); setFiles(attached); setSendError(errorText(failure)); }
  };
  return (
    <View style={styles.screen}>
      {header ? header(chat) : (
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>{chat?.title ?? ''}</Text>
          {chat?.place ? <Text style={styles.muted}>{chat.place}</Text> : null}
        </View>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ChatTimeline store={store} connection={connection} canAct={canAct} />
      <KeyboardStickyView offset={{closed: 0, opened: 0}}>
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
        {!canAct ? <Text style={styles.note}>{READ_ONLY_NOTE}</Text> : null}
        {files.length ? <View style={styles.files}>
          {files.map(file => <View key={file.key} style={styles.file}>
            <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
            {file.attachment ? null : <Text style={styles.muted}>{`${Math.floor(file.sent * 100 / Math.max(1, file.size))}%`}</Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} hitSlop={12} onPress={() => remove(file)}><Text style={styles.remove}>×</Text></Pressable>
          </View>)}
        </View> : null}
        {steering && files.length ? <Text style={styles.note}>Photos and files go with your next message, once this turn ends.</Text> : null}
        {menu ? <View style={styles.menu}>{SOURCES.map(([source, label]) => <Button key={source} label={label} onPress={() => void attach(source)} />)}</View> : null}
        <View style={styles.composer}>
          {pickAttachment ? <Pressable accessibilityRole="button" accessibilityLabel="Attach" disabled={!canAct} onPress={() => setMenu(open => !open)} hitSlop={6} style={[styles.attach, !canAct && styles.dim]}>
            <Text style={styles.attachLabel}>+</Text>
          </Pressable> : null}
          <TextInput style={styles.input} placeholder={steering ? 'Steer the running agent…' : 'Message'} placeholderTextColor={c.faint} value={draft} onChangeText={setDraft} editable={canAct} multiline />
          <Button label={steering ? 'Steer' : 'Send'} kind="primary" disabled={!canAct || !draft.trim() || uploading || (steering && files.length > 0)} onPress={() => void submit()} />
        </View>
      </KeyboardStickyView>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  header: {paddingHorizontal: space.l, paddingVertical: space.m, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border},
  title: {color: c.strong, ...type.headline, fontWeight: '600'},
  muted: {color: c.muted, ...type.label},
  error: {color: c.danger, ...type.label, paddingHorizontal: space.l, paddingTop: space.xs},
  note: {color: c.muted, ...type.label, paddingHorizontal: space.l, paddingTop: space.s},
  composer: {flexDirection: 'row', alignItems: 'flex-end', gap: space.s, marginHorizontal: space.s, marginTop: space.s, marginBottom: space.m, padding: space.s, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 20},
  files: {flexDirection: 'row', flexWrap: 'wrap', gap: space.s, paddingHorizontal: space.m, paddingTop: space.s},
  file: {flexDirection: 'row', alignItems: 'center', gap: space.s, maxWidth: '100%', borderWidth: 1, borderColor: c.control, borderRadius: 8, paddingHorizontal: space.s, paddingVertical: 2},
  fileName: {color: c.text, ...type.label, flexShrink: 1},
  remove: {color: c.text, ...type.body, paddingHorizontal: space.xs},
  menu: {flexDirection: 'row', gap: space.s, paddingHorizontal: space.m, paddingTop: space.s},
  attach: {width: touch - 8, height: touch - 8, borderRadius: 18, borderWidth: 1, borderColor: c.control, alignItems: 'center', justifyContent: 'center'},
  attachLabel: {color: c.text, fontSize: 20, lineHeight: 22},
  dim: {opacity: 0.5},
  input: {flex: 1, minHeight: touch - 8, maxHeight: 140, color: c.text, paddingHorizontal: space.s, paddingVertical: space.s, ...type.body},
}));
