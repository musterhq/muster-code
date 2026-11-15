/** Switch branch (v3, MUS-SPEC-23-25K): one field that finds and creates, the computer's local branches and its remote ones
 *  with ahead and behind in words, and what happens to uncommitted files said once above the list. A running agent is paused
 *  on the computer before the branch changes. */
import {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {MobileBranch, MobileConnection, MobileMethods} from '../shared';
import {errorText} from '../hooks';
import {haptics} from '../haptics';
import {Icon} from '../components/Icon';
import {font, radius, space, themed, type, useTheme} from '../theme';

type Branches = MobileMethods['git.branches']['result'];
const words = (branch: MobileBranch) => branch.current ? 'Current' : [branch.ahead ? `${branch.ahead} ahead` : '', branch.behind ? `${branch.behind} behind` : ''].filter(Boolean).join(', ');

export function BranchSheet({connection, chatId, onDone}: {connection: MobileConnection; chatId: string; onDone(branch: string): void}) {
  const styles = useStyles(), c = useTheme();
  const [branches, setBranches] = useState<Branches | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { connection.call('git.branches', {chatId}).then(setBranches, failure => setError(errorText(failure))); }, [connection, chatId]);
  const go = async (branch: string, how: {create?: true; remote?: true} = {}) => {
    if (busy) return;
    setBusy(branch); haptics.select();
    try {
      const result = await connection.call('git.switch', {chatId, branch, ...how});
      if (result.paused) haptics.warning(); else haptics.success();
      onDone(result.status.branch);
    } catch (failure) { setError(errorText(failure)); haptics.warning(); } finally { setBusy(null); }
  };
  const needle = query.trim().toLowerCase();
  const match = (branch: MobileBranch) => !needle || branch.name.toLowerCase().includes(needle);
  const local = branches?.local.filter(match) ?? [], remote = branches?.remote.filter(match) ?? [];
  const canCreate = needle && !branches?.local.some(branch => branch.name === query.trim());
  const row = (branch: MobileBranch, index: number, how: {remote?: true}) => (
    <Pressable key={branch.name} accessibilityRole="button" accessibilityLabel={branch.name} accessibilityState={{selected: Boolean(branch.current), busy: busy === branch.name}} disabled={branch.current || busy !== null}
      onPress={() => void go(branch.name, how)} style={({pressed}) => [styles.row, index > 0 && styles.divider, pressed && styles.pressed]}>
      <Icon name={how.remote ? 'cloud' : 'branch'} size={18} color={c.muted} stroke={1.9} />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>{branch.name}</Text>
        {words(branch) ? <Text style={styles.muted}>{words(branch)}</Text> : null}
      </View>
      {branch.current ? <Icon name="check" size={18} color={c.accent} stroke={2.6} /> : null}
    </Pressable>
  );
  return (
    <ScrollView style={styles.sheet} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.find}>
        <Icon name="search" size={17} color={c.muted} stroke={2.2} />
        <TextInput accessibilityLabel="Find or create a branch" placeholder="Find or create a branch" placeholderTextColor={c.faint} value={query} onChangeText={setQuery}
          autoCapitalize="none" autoCorrect={false} style={styles.input} />
      </View>
      {branches && branches.uncommitted ? <View style={styles.note}>
        <Icon name="alert" size={15} color={c.muted} stroke={2} />
        <Text style={styles.noteText}>{`${branches.uncommitted === 1 ? '1 uncommitted file moves' : `${branches.uncommitted} uncommitted files move`} with you.${branches.running ? ' The agent pauses first.' : ''}`}</Text>
      </View> : branches?.running ? <View style={styles.note}><Text style={styles.noteText}>The agent pauses first.</Text></View> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {canCreate ? <View style={styles.group}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Create “${query.trim()}”`} disabled={busy !== null} onPress={() => void go(query.trim(), {create: true})} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
          <Icon name="plus" size={18} color={c.accent} stroke={2.2} /><Text style={[styles.name, {color: c.accent}]}>{`Create “${query.trim()}”`}</Text>
        </Pressable>
      </View> : null}
      {local.length ? <><Text style={styles.section}>{`On ${connection.desktopName}`}</Text><View style={styles.group}>{local.map((branch, index) => row(branch, index, {}))}</View></> : null}
      {remote.length ? <><Text style={styles.section}>Remote</Text><View style={styles.group}>{remote.map((branch, index) => row(branch, index, {remote: true}))}</View></> : null}
      {!branches && !error ? <Text style={styles.muted}>Loading…</Text> : null}
    </ScrollView>
  );
}
const useStyles = themed(c => StyleSheet.create({
  sheet: {flex: 1, backgroundColor: c.raised},
  content: {paddingTop: space.l, paddingBottom: 40},
  find: {flexDirection: 'row', alignItems: 'center', gap: space.s, height: 44, marginHorizontal: space.card, paddingHorizontal: 14, borderRadius: 22, backgroundColor: c.fill},
  input: {flex: 1, color: c.text, ...type.body, paddingVertical: 0},
  note: {flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: space.margin, paddingTop: space.m},
  noteText: {flex: 1, color: c.muted, ...type.footnote},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin, paddingTop: space.s},
  section: {color: c.muted, ...type.footnote, fontWeight: '600', paddingHorizontal: space.margin, paddingTop: space.l, paddingBottom: space.s},
  group: {marginHorizontal: space.card, marginTop: space.s, backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: space.l, paddingVertical: 10},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  pressed: {backgroundColor: c.fill},
  body: {flex: 1, gap: 2},
  name: {color: c.text, ...type.subhead, fontFamily: font.mono},
  muted: {color: c.muted, ...type.footnote, paddingHorizontal: 0},
}));
