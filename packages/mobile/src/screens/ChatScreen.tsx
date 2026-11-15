/** One chat: its timeline streaming live in a virtualized list, approval and question cards in place, and the composer. The
 *  composer rides the keyboard. With the computer offline it shows the cached chat under a banner; messages go to the
 *  outbox and approvals wait.
 *
 *  v3: the composer is one glass row (add, field, send). Its chips (Photo, Camera, File) show only while it is focused
 *  (MUS-SPEC-23-24E). While a turn runs, Send turns into Stop wrapped in a moving ring; with text typed it is Steer, and a
 *  hint says the message goes to the running turn (24D). When a turn ends while the chat is open, its live line resolves into
 *  the run's summary with a success haptic (24C). */
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {KeyboardStickyView} from 'react-native-keyboard-controller';
import {sha256} from '@noble/hashes/sha2.js';
import {uploadAttachment, type MobileAttachment, type MobileChat, type MobileConnection} from '../shared';
import type {AttachSource, PickAttachment} from '../attachments';
import {errorText, READ_ONLY_NOTE, requestId, useAccess, useChat, useOutbox} from '../hooks';
import {cacheScopeOf, offlineOf} from '../offline/connection';
import {ConnectionBanner} from '../components/ConnectionBanner';
import type {LinkPath} from '../connection/link';
import {haptics} from '../haptics';
import {Button} from '../components/Button';
import {Icon} from '../components/Icon';
import {ChatTimeline, lastWorkSpan} from '../components/ChatTimeline';
import {took} from '../components/WorkCapsule';
import {Glass, Spinner} from '../components/v3';
import {RunFinished} from './Moments';
import {space, themed, type, useTheme} from '../theme';

const BUSY = new Set(['running', 'stopping', 'waiting']);
const RUNNING = new Set(['running', 'stopping']);

/** A file in the composer: uploading (with how much has arrived) or ready to send. */
interface Draft { key: string; name: string; size: number; sent: number; attachment: MobileAttachment | null }
const SOURCES: Array<[AttachSource, string, 'image' | 'camera' | 'file']> = [['photo', 'Photo', 'image'], ['camera', 'Camera', 'camera'], ['file', 'File', 'file']];

/** How many files the chat's latest turn changed (0 when none, or the computer can't say). */
export function useChangeCount(connection: MobileConnection, chatId: string, stamp: string | undefined): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (offlineOf(connection)) return;
    let live = true;
    connection.call('changes.list', {chatId}).then(result => { if (live) setCount((result.files ?? []).filter(file => file.state !== "undone").length); }, () => undefined);
    return () => { live = false; };
  }, [connection, chatId, stamp]);
  return count;
}

/** `header`: how the chat's title is shown. A stack route passes one that sets its native header (one bar, no second header
 *  in the body); a tablet pane or a test leaves it out and the title shows at the top of the screen. `onReview` opens the
 *  turn's changes. */
export function ChatScreen({connection, chatId, pickAttachment, header, path, onReview}: {connection: MobileConnection; chatId: string; pickAttachment?: PickAttachment; header?: (chat: MobileChat | null, changes: number) => ReactNode; path?: LinkPath; onReview?(): void}) {
  const {chat, store, error} = useChat(connection, chatId);
  const styles = useStyles(), c = useTheme();
  const access = useAccess(connection);
  const canAct = access === 'act';
  const offline = offlineOf(connection);
  const queued = useOutbox(connection, chatId);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [files, setFiles] = useState<Draft[]>([]);
  const [focused, setFocused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const running = Boolean(chat && RUNNING.has(chat.status)) && !offline;
  const steering = Boolean(chat && BUSY.has(chat.status)) && !offline;
  const changes = useChangeCount(connection, chatId, chat ? `${chat.status}:${RUNNING.has(chat.status)}` : undefined);
  // A turn that ends while the chat is open resolves into its summary, once, with a success haptic.
  const [finished, setFinished] = useState<{took: string | null} | null>(null);
  const was = useRef<string | null>(null);
  useEffect(() => {
    if (!chat) return;
    const before = was.current;
    was.current = chat.status;
    if (RUNNING.has(chat.status)) { setFinished(null); setStopping(false); return; }
    if (before && RUNNING.has(before) && (chat.status === 'completed' || chat.status === 'failed' || chat.status === 'interrupted')) {
      const span = lastWorkSpan(store);
      setFinished({took: span && span >= 1000 ? took(span) : null});
      if (chat.status === 'completed') haptics.success(); else haptics.warning();
    }
  }, [chat?.status]);
  const uploading = files.some(file => !file.attachment);
  const update = (key: string, change: Partial<Draft>) => setFiles(current => current.map(file => file.key === key ? {...file, ...change} : file));
  const attach = async (source: AttachSource) => {
    haptics.select(); setSendError(null);
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
  const stop = async () => {
    if (stopping) return;
    haptics.light(); setStopping(true); setSendError(null);
    try { await connection.call('chat.stop', {id: chatId}); } catch (failure) { setStopping(false); setSendError(errorText(failure)); }
  };
  const submit = async () => {
    const text = draft.trim();
    if (!text || !canAct || uploading) return;
    // Files go with a new message; a running turn can't take them (the desktop's rule), so Steer waits for the turn to end.
    if (steering && files.length) return;
    if (offline) {
      // Offline: the message waits in the outbox and goes out, once, when the computer is back.
      const scope = cacheScopeOf(connection)!;
      setDraft(''); setSendError(null); haptics.light();
      scope.cache.enqueue(scope.computerId, chatId, text);
      return;
    }
    const attached = files;
    setDraft(''); setFiles([]); setSendError(null);
    haptics.light();
    try {
      if (steering) {
        const result = await connection.call('chat.steer', {id: chatId, text, requestId: requestId()});
        if (!result.steered) setSendError(result.reason ?? 'The turn ended first; send it again to start a new one.');
      } else await connection.call('chat.send', {id: chatId, text, requestId: requestId(), ...(attached.length ? {attachmentIds: attached.map(file => file.attachment!.id)} : {})});
    } catch (failure) { setDraft(text); setFiles(attached); setSendError(errorText(failure)); }
  };
  const typed = Boolean(draft.trim());
  const showStop = running && !typed && canAct;
  const chips = Boolean(pickAttachment) && !offline && canAct && focused;
  return (
    <View style={styles.screen}>
      {header ? header(chat, changes) : (
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>{chat?.title ?? ''}</Text>
          {chat?.place ? <Text style={styles.muted}>{chat.place}</Text> : null}
        </View>
      )}
      {offline ? <ConnectionBanner name={offline.name} path={path ?? 'offline'} lastSync={offline.cache.lastSync(offline.computerId)} onRetry={offline.retry} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ChatTimeline store={store} connection={connection} canAct={canAct} running={running} {...(offline ? {offline: offline.name} : {})}
        footer={finished && chat ? <RunFinished took={finished.took} files={changes} {...(onReview ? {onReview} : {})} /> : null} />
      <KeyboardStickyView offset={{closed: 0, opened: 0}}>
        {queued.length ? <View style={styles.queue}>
          {queued.map(entry => <View key={entry.id} style={styles.queued} accessibilityLabel={`${entry.text}, ${entry.error ? 'not sent' : 'waiting to send'}`}>
            <Text style={styles.queuedText}>{entry.text}</Text>
            <View style={styles.queuedNote}><Icon name="clock" size={13} color={entry.error ? c.danger : c.muted} /><Text style={entry.error ? styles.queuedError : styles.queuedWait}>{entry.error ? `Not sent: ${entry.error}` : 'Waiting to send'}</Text></View>
          </View>)}
        </View> : null}
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
        {files.length ? <View style={styles.files}>
          {files.map(file => <View key={file.key} style={styles.file}>
            <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
            {file.attachment ? null : <Text style={styles.muted}>{`${Math.floor(file.sent * 100 / Math.max(1, file.size))}%`}</Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${file.name}`} hitSlop={12} onPress={() => remove(file)}><Icon name="x" size={16} color={c.muted} /></Pressable>
          </View>)}
        </View> : null}
        {steering && files.length ? <Text style={styles.note}>Photos and files go with your next message, once this turn ends.</Text> : null}
        {steering && typed && canAct ? <Text style={styles.note}>Steer: this goes to the running turn.</Text> : null}
        {chips ? <View style={styles.chips}>{SOURCES.map(([source, label, icon]) => <Button key={source} label={label} icon={icon} kind="tint" small onPress={() => void attach(source)} />)}</View> : null}
        {!canAct ? (
          <Glass radius={26} style={styles.readOnly}><Icon name="eye" size={20} color={c.muted} stroke={1.9} /><Text style={styles.readOnlyText}>{READ_ONLY_NOTE}</Text></Glass>
        ) : (
          <Glass radius={26} style={styles.composer}>
            {pickAttachment && !offline ? <Pressable accessibilityRole="button" accessibilityLabel="Attach" onPress={() => setFocused(on => !on)} hitSlop={6} style={styles.add}>
              <Icon name="plus" size={20} color={c.text} stroke={2.2} />
            </Pressable> : null}
            <TextInput testID="composer-input" style={styles.input} placeholder={offline ? `Queued until ${offline.name} is back…` : steering ? 'Steer the agent' : 'Message'} placeholderTextColor={c.muted}
              value={draft} onChangeText={setDraft} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} multiline />
            {showStop ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Stop" accessibilityState={{busy: stopping}} onPress={() => void stop()} style={styles.stop}>
                <View style={StyleSheet.absoluteFill} pointerEvents="none"><Spinner size={48} color={c.accent} stroke={2} /></View>
                <View style={[styles.circle, {backgroundColor: c.text}]}><Icon name="stop" size={16} color={c.background} /></View>
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel={steering ? 'Steer' : 'Send'} accessibilityState={{disabled: !typed || uploading}} disabled={!typed || uploading || (steering && files.length > 0)} onPress={() => void submit()}
                style={[styles.circle, {backgroundColor: typed ? c.accentFill : c.fill}]}>
                <Icon name="up" size={20} color={typed ? c.onAccent : c.faint} stroke={2.4} />
              </Pressable>
            )}
          </Glass>
        )}
      </KeyboardStickyView>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  header: {paddingHorizontal: space.margin, paddingVertical: space.m},
  title: {color: c.text, ...type.headline},
  muted: {color: c.muted, ...type.footnote},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin, paddingTop: space.xs},
  note: {color: c.muted, ...type.footnote, paddingHorizontal: space.margin + 4, paddingTop: space.s},
  composer: {flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginHorizontal: space.card, marginTop: space.s, marginBottom: space.m, padding: 6, minHeight: 52},
  readOnly: {flexDirection: 'row', alignItems: 'center', gap: space.m, marginHorizontal: space.card, marginTop: space.s, marginBottom: space.m, paddingHorizontal: space.l, paddingVertical: 14},
  readOnlyText: {flex: 1, color: c.muted, ...type.subhead},
  add: {width: 40, height: 40, borderRadius: 20, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center'},
  circle: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
  stop: {width: 48, height: 48, margin: -4, alignItems: 'center', justifyContent: 'center'},
  input: {flex: 1, minHeight: 40, maxHeight: 140, color: c.text, paddingHorizontal: 4, paddingTop: 9, paddingBottom: 9, ...type.body},
  chips: {flexDirection: 'row', gap: space.s, paddingHorizontal: space.card, paddingTop: space.s},
  files: {flexDirection: 'row', flexWrap: 'wrap', gap: space.s, paddingHorizontal: space.card, paddingTop: space.s},
  file: {flexDirection: 'row', alignItems: 'center', gap: space.s, maxWidth: '100%', borderRadius: 18, backgroundColor: c.surface, paddingHorizontal: space.m, height: 36},
  fileName: {color: c.text, ...type.subhead, flexShrink: 1},
  queue: {alignItems: 'flex-end', gap: space.s, paddingHorizontal: space.margin, paddingTop: space.s},
  queued: {maxWidth: '84%', borderRadius: 22, backgroundColor: c.bubble, opacity: 0.6, paddingVertical: 11, paddingHorizontal: space.l, gap: 4},
  queuedText: {color: c.text, fontSize: 17, lineHeight: 23},
  queuedNote: {flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end'},
  queuedWait: {color: c.muted, ...type.caption},
  queuedError: {color: c.danger, ...type.caption},
}));
