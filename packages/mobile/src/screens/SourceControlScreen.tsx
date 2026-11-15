/** Source control for the chat's folder (v3, MUS-SPEC-23-25J): the branch is the headline with ahead and behind in words, the
 *  files to commit are a selection list with round checks, and the message is the agent's, editable. Commit and push is the
 *  primary action; both run on the computer, which checks act access again right before it writes. */
import {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {MobileConnection, MobileGitStatus} from '../shared';
import {errorText, useAccess} from '../hooks';
import {haptics} from '../haptics';
import {Button} from '../components/Button';
import {Icon} from '../components/Icon';
import {font, radius, space, themed, type, useTheme} from '../theme';
import {CHANGE_WORD, changeColor} from './FilesScreen';

export const aheadWords = (status: Pick<MobileGitStatus, 'ahead' | 'behind' | 'upstream'>): string => !status.upstream ? 'Not published yet'
  : [status.ahead ? `${status.ahead} ahead` : '', status.behind ? `${status.behind} behind` : ''].filter(Boolean).join(', ') || 'Up to date';
const messageOf = (status: MobileGitStatus) => status.message ? [status.message.subject, status.message.body].filter(Boolean).join('\n\n') : '';

export function SourceControlScreen({connection, chatId, onSwitchBranch, onOpenPullRequest}: {connection: MobileConnection; chatId: string; onSwitchBranch(): void; onOpenPullRequest(): void}) {
  const styles = useStyles(), c = useTheme();
  const canAct = useAccess(connection) === 'act';
  const [status, setStatus] = useState<MobileGitStatus | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => connection.call('git.status', {chatId}).then(next => {
    setStatus(next); setChosen(new Set(next.files.map(file => file.path)));
    const written = messageOf(next); setAgent(written); setMessage(current => current || written); setError(null);
  }, failure => setError(errorText(failure)));
  useEffect(() => { void load(); }, [connection, chatId]);
  const toggle = (path: string) => { haptics.select(); setChosen(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; }); };
  const commit = async (push: boolean) => {
    if (!status || busy) return;
    setBusy(push ? 'push' : 'commit');
    try {
      const result = await connection.call('git.commit', {chatId, revision: status.revision, paths: status.files.map(file => file.path).filter(path => chosen.has(path)), message, ...(push ? {push: true} : {})});
      setStatus(result.status); setChosen(new Set(result.status.files.map(file => file.path))); setMessage(''); setAgent('');
      if (result.pushError) { setError(`Committed, but the push did not go through: ${result.pushError}`); haptics.warning(); } else { setError(null); haptics.success(); }
    } catch (failure) { setError(errorText(failure)); haptics.warning(); } finally { setBusy(null); }
  };
  if (!status) return <View style={styles.screen}><Text style={error ? styles.error : styles.muted}>{error ?? 'Loading…'}</Text></View>;
  const ready = canAct && chosen.size > 0 && message.trim().length > 0 && !status.conflicted;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.branch}>
        <View style={styles.tile}><Icon name="branch" size={18} color={c.accent} stroke={1.9} /></View>
        <View style={styles.body}>
          <Text style={styles.branchName} numberOfLines={1}>{status.detached ? 'Detached' : status.branch}</Text>
          <Text style={styles.muted}>{aheadWords(status)}</Text>
        </View>
        {canAct ? <Button label="Switch" small onPress={onSwitchBranch} /> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.section}>{status.files.length ? `To commit · ${chosen.size} of ${status.files.length}` : 'Nothing to commit'}</Text>
      {status.files.length ? <View style={styles.group}>
        {status.files.map((file, index) => {
          const on = chosen.has(file.path);
          return (
            <Pressable key={file.path} accessibilityRole="checkbox" accessibilityLabel={file.path} accessibilityState={{checked: on, disabled: !canAct}} disabled={!canAct} onPress={() => toggle(file.path)}
              style={({pressed}) => [styles.row, index > 0 && styles.divider, pressed && styles.pressed]}>
              {canAct ? <View style={[styles.check, on && {backgroundColor: c.accent, borderColor: c.accent}]}>{on ? <Icon name="check" size={14} color={c.onAccent} stroke={3} /> : null}</View> : null}
              <Text style={styles.path} numberOfLines={1}>{file.path}</Text>
              <Text style={[styles.word, {color: changeColor(c, file.change)}]}>{CHANGE_WORD[file.change]}</Text>
            </Pressable>
          );
        })}
      </View> : null}
      {status.files.length ? <>
        <View style={styles.messageHead}>
          <Text style={styles.sectionInline}>Message</Text>
          {agent && message === agent ? <View style={styles.by}><Icon name="sparkle" size={13} color={c.accent} stroke={2.2} /><Text style={styles.byText}>Written by the agent</Text></View> : null}
        </View>
        {canAct ? <TextInput accessibilityLabel="Commit message" value={message} onChangeText={setMessage} multiline placeholder="Describe the change" placeholderTextColor={c.faint} style={[styles.message, styles.input]} />
          : <Text style={styles.message}>{message || 'No message yet.'}</Text>}
      </> : null}
      {canAct && status.files.length ? <View style={styles.actions}>
        <Button label="Commit" grow busy={busy === 'commit'} disabled={!ready || busy !== null} onPress={() => void commit(false)} />
        <Button label="Commit and push" kind="primary" grow busy={busy === 'push'} disabled={!ready || busy !== null} onPress={() => void commit(true)} />
      </View> : null}
      {canAct ? <Pressable accessibilityRole="button" accessibilityLabel="Open a pull request" onPress={onOpenPullRequest} style={styles.link}>
        <Icon name="branch" size={16} color={c.accent} stroke={2.2} /><Text style={styles.linkText}>Open a pull request</Text>
      </Pressable> : null}
    </ScrollView>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  content: {paddingBottom: 60, paddingTop: space.s},
  branch: {flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: space.card, padding: space.l, borderRadius: radius.group, backgroundColor: c.surface},
  tile: {width: 36, height: 36, borderRadius: 10, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center'},
  body: {flex: 1, gap: 2},
  branchName: {color: c.text, ...type.headline, fontFamily: font.mono},
  muted: {color: c.muted, ...type.footnote},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin, paddingTop: space.s},
  section: {color: c.muted, ...type.footnote, fontWeight: '600', paddingHorizontal: space.margin, paddingTop: space.xl, paddingBottom: space.s},
  sectionInline: {color: c.muted, ...type.footnote, fontWeight: '600'},
  group: {marginHorizontal: space.card, backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: space.l, paddingVertical: 10},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  pressed: {backgroundColor: c.raised},
  check: {width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: c.control, alignItems: 'center', justifyContent: 'center'},
  path: {flex: 1, color: c.text, ...type.subhead, fontFamily: font.mono},
  word: {...type.footnote, fontWeight: '500'},
  messageHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.margin, paddingTop: space.xl, paddingBottom: space.s},
  by: {flexDirection: 'row', alignItems: 'center', gap: 4},
  byText: {color: c.accent, ...type.footnote},
  message: {marginHorizontal: space.card, padding: space.l, borderRadius: radius.well, backgroundColor: c.surface, color: c.text, ...type.subhead},
  input: {minHeight: 96, textAlignVertical: 'top'},
  actions: {flexDirection: 'row', gap: space.s, marginHorizontal: space.card, marginTop: space.l},
  link: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.margin, paddingVertical: space.l},
  linkText: {color: c.accent, ...type.subhead, fontWeight: '500'},
}));
