/** The chat's changed files (v3, MUS-SPEC-23-24N): a ring for how much is reviewed, each file with its size of change until
 *  it is decided and then just the decision in a word. A phone that can act swipes a file right to keep it and left to undo
 *  it, and has Keep all and Undo all in a glass bar; the computer checks access again before each write. */
import {useEffect, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileChange, MobileConnection, MobileReviewState} from '../shared';
import {errorText, useAccess} from '../hooks';
import {haptics} from '../haptics';
import {Button} from '../components/Button';
import {Icon} from '../components/Icon';
import {SwipeRow} from '../components/SwipeRow';
import {EdgeFade, Glass, ProgressRing} from '../components/v3';
import {radius, size, space, themed, type, useTheme} from '../theme';

export const fileName = (path: string) => path.split('/').pop() ?? path;
export const folderOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export function Stat({adds, dels}: {adds: number; dels: number}) {
  const styles = useStyles();
  return <Text style={styles.stat}>{adds ? <Text style={styles.add}>{`+${adds}`}</Text> : null}{adds && dels ? ' ' : ''}{dels ? <Text style={styles.del}>{`−${dels}`}</Text> : null}</Text>;
}

/** The turn's files, live from the computer, with this screen's decisions on top. */
export function useChanges(connection: MobileConnection, chatId: string) {
  const [runId, setRunId] = useState<string | null>(null);
  const [files, setFiles] = useState<MobileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => connection.call('changes.list', {chatId}).then(result => { setRunId(result.runId); setFiles(result.files); setError(null); }, failure => setError(errorText(failure)));
  useEffect(() => { void load(); }, [connection, chatId]);
  const mark = (path: string, state: MobileReviewState) => setFiles(current => current?.map(file => file.path === path ? {...file, state} : file) ?? null);
  return {runId, files, error, setError, mark, reload: load};
}

export function ChangesScreen({connection, chatId, onOpenFile}: {connection: MobileConnection; chatId: string; onOpenFile(path: string): void}) {
  const styles = useStyles(), c = useTheme();
  const canAct = useAccess(connection) === 'act';
  const {runId, files, error, setError, mark} = useChanges(connection, chatId);
  const keep = async (file: MobileChange) => {
    if (!runId || file.state !== 'review') return;
    try { await connection.call('changes.keep', {chatId, runId, path: file.path, hunkIds: ['*']}); mark(file.path, 'kept'); haptics.light(); }
    catch (failure) { setError(errorText(failure)); }
  };
  const undo = async (file: MobileChange) => {
    if (!runId || file.state === 'undone') return;
    try {
      const {stale} = await connection.call('changes.undo', {chatId, runId, path: file.path, afterHash: file.afterHash});
      if (stale) { setError(`${fileName(file.path)} changed on the computer after you read it, so it was left as it is.`); haptics.warning(); return; }
      mark(file.path, 'undone'); haptics.light();
    } catch (failure) { setError(errorText(failure)); }
  };
  const open = (files ?? []).filter(file => file.state === 'review');
  const keepAll = async () => { for (const file of open) await keep(file); };
  const undoAll = () => {
    haptics.warning();
    Alert.alert('Undo every change still to review?', 'Each file goes back to how it was before this turn, on the computer.', [{text: 'Cancel', style: 'cancel'}, {text: 'Undo all', style: 'destructive', onPress: () => void (async () => { for (const file of open) await undo(file); })()}]);
  };
  if (!files) return <View style={styles.screen}>{error ? <Text style={styles.error}>{error}</Text> : <Text style={styles.muted}>Loading changes…</Text>}</View>;
  const kept = files.filter(file => file.state === 'kept').length, decided = files.length - open.length;
  const adds = files.reduce((sum, file) => sum + file.adds, 0), dels = files.reduce((sum, file) => sum + file.dels, 0);
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.summary}>
          <ProgressRing value={files.length ? decided / files.length : 1} size={56} label={`Reviewed ${decided} of ${files.length}`} />
          <View style={styles.summaryText}>
            <Text style={styles.count}>{files.length === 1 ? '1 file' : `${files.length} files`}</Text>
            <Text style={styles.muted}>{!files.length ? 'Nothing changed in this turn' : `${kept} kept · ${open.length} to review`}</Text>
          </View>
          <Stat adds={adds} dels={dels} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {files.length ? <View style={styles.group}>
          {files.map((file, index) => {
            const row = (
              <Pressable accessibilityRole="button" accessibilityLabel={`${fileName(file.path)}, ${file.state === 'kept' ? 'Kept' : file.state === 'undone' ? 'Undone' : `${file.adds} added, ${file.dels} removed`}`}
                disabled={file.state === 'undone'} onPress={() => onOpenFile(file.path)} style={({pressed}) => [styles.row, index > 0 && styles.divider, pressed && styles.pressed]}>
                <View style={styles.tile}><Icon name="file" size={18} color={c.accent} stroke={1.9} /></View>
                <View style={styles.body}>
                  <Text style={[styles.name, file.state === 'undone' && styles.dim]} numberOfLines={1}>{fileName(file.path)}</Text>
                  {folderOf(file.path) ? <Text style={styles.path} numberOfLines={1}>{folderOf(file.path)}</Text> : null}
                </View>
                {file.state === 'kept' ? <View style={styles.word}><Icon name="check" size={18} color={c.success} stroke={2.4} /><Text style={[styles.wordText, {color: c.success}]}>Kept</Text></View>
                  : file.state === 'undone' ? <View style={styles.word}><Icon name="undo" size={16} color={c.danger} stroke={2.2} /><Text style={[styles.wordText, {color: c.danger}]}>Undone</Text></View>
                  : file.binary ? <Text style={styles.muted}>Binary</Text> : <Stat adds={file.adds} dels={file.dels} />}
              </Pressable>
            );
            return <View key={file.path}>{canAct && file.state === 'review' ? <SwipeRow testID={`swipe-${file.path}`} rightLabel="Keep" leftLabel="Undo" onRight={() => void keep(file)} onLeft={() => void undo(file)}>{row}</SwipeRow> : row}</View>;
          })}
        </View> : null}
      </ScrollView>
      {canAct && open.length ? <>
        <EdgeFade edge="bottom" height={150} />
        <Glass radius={30} style={styles.bar}>
          <Button label="Undo all" kind="danger" small onPress={undoAll} />
          <View style={styles.grow} />
          <Button label="Keep all" small onPress={() => void keepAll()} />
        </Glass>
      </> : null}
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  content: {paddingBottom: 140},
  summary: {flexDirection: 'row', alignItems: 'center', gap: space.l, paddingHorizontal: space.margin, paddingVertical: space.l},
  summaryText: {flex: 1, gap: 2},
  count: {color: c.text, ...type.title2},
  muted: {color: c.muted, ...type.subhead, padding: space.xs},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin, paddingBottom: space.s},
  group: {marginHorizontal: space.card, backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 66, paddingHorizontal: space.l, paddingVertical: 11, backgroundColor: c.surface},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  pressed: {backgroundColor: c.raised},
  tile: {width: 32, height: 32, borderRadius: 8, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center'},
  body: {flex: 1, gap: 2},
  name: {color: c.text, ...type.body, fontWeight: '500'},
  dim: {color: c.faint},
  path: {color: c.muted, ...type.footnote, fontFamily: type.code.fontFamily},
  word: {flexDirection: 'row', alignItems: 'center', gap: 5},
  wordText: {...type.subhead, fontWeight: '500'},
  stat: {...type.code, fontSize: 14},
  add: {color: c.success},
  del: {color: c.danger},
  bar: {position: 'absolute', left: space.card, right: space.card, bottom: 34, height: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.s, zIndex: 6},
  grow: {flex: 1},
}));
