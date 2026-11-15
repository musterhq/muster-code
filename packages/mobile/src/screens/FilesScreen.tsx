/** The chat's folder, one level per screen (v3 Files, MUS-SPEC-23-25D): the folder as a large title with its path under it,
 *  All / Changed / Recent, recently opened files as cards, and each file's Git state as a word in colour. Read-only phones
 *  browse too; the computer keeps every path inside the chat's folder. */
import {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileConnection, MobileFileChange, MobileFileEntry, MobileGitStatus} from '../shared';
import {errorText} from '../hooks';
import {haptics} from '../haptics';
import {Icon} from '../components/Icon';
import {recentFiles, recentScope} from '../recent';
import {ago} from '../time';
import {radius, space, themed, type, useTheme, type Palette} from '../theme';
import {fileName} from './ChangesScreen';

export const CHANGE_WORD: Record<MobileFileChange, string> = {modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', conflict: 'Conflict'};
export const changeColor = (c: Palette, change: MobileFileChange) => change === 'added' ? c.success : change === 'deleted' || change === 'conflict' ? c.danger : c.warning;
type Segment = 'all' | 'changed' | 'recent';

export function FilesScreen({connection, chatId, path = '', onOpenFolder, onOpenFile}: {connection: MobileConnection; chatId: string; path?: string; onOpenFolder(path: string): void; onOpenFile(path: string): void}) {
  const styles = useStyles(), c = useTheme();
  const [listing, setListing] = useState<{folder: string; entries: MobileFileEntry[]} | null>(null);
  const [status, setStatus] = useState<MobileGitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<Segment>('all');
  useEffect(() => {
    let live = true;
    connection.call('files.list', {chatId, ...(path ? {path} : {})}).then(result => { if (live) { setListing(result); setError(null); } }, failure => { if (live) setError(errorText(failure)); });
    connection.call('git.status', {chatId}).then(result => { if (live) setStatus(result); }, () => undefined);
    return () => { live = false; };
  }, [connection, chatId, path]);
  const recent = recentFiles(recentScope(connection.deviceId, chatId));
  const changed = status?.files ?? [];
  const title = path ? fileName(path) : listing?.folder ?? '';
  const pick = (next: Segment) => { if (next !== segment) { haptics.select(); setSegment(next); } };
  const fileRow = (key: string, filePath: string, change: MobileFileChange | undefined, index: number, note?: string) => (
    <Pressable key={key} accessibilityRole="button" accessibilityLabel={change ? `${fileName(filePath)}, ${CHANGE_WORD[change]}` : fileName(filePath)} onPress={() => onOpenFile(filePath)}
      style={({pressed}) => [styles.row, index > 0 && styles.divider, pressed && styles.pressed]}>
      <View style={styles.tile}><Icon name="file" size={18} color={c.accent} stroke={1.9} /></View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>{fileName(filePath)}</Text>
        {note ? <Text style={styles.sub} numberOfLines={1}>{note}</Text> : null}
      </View>
      {change ? <Text style={[styles.word, {color: changeColor(c, change)}]}>{CHANGE_WORD[change]}</Text> : null}
    </Pressable>
  );
  const rows = segment === 'changed' ? changed.map((file, index) => fileRow(`c:${file.path}`, file.path, file.change, index, file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : undefined))
    : segment === 'recent' ? recent.map((entry, index) => fileRow(`r:${entry.path}`, entry.path, undefined, index, ago(entry.at)))
    : (listing?.entries ?? []).map((entry, index) => entry.kind === 'directory'
      ? <Pressable key={entry.path} accessibilityRole="button" accessibilityLabel={`${entry.name}, folder`} onPress={() => onOpenFolder(entry.path)} style={({pressed}) => [styles.row, index > 0 && styles.divider, pressed && styles.pressed]}>
          <View style={[styles.tile, styles.folderTile]}><Icon name="folder" size={18} color={c.muted} stroke={1.9} /></View>
          <View style={styles.body}><Text style={styles.name} numberOfLines={1}>{entry.name}</Text></View>
          {entry.changed ? <Text style={[styles.word, {color: c.warning}]}>{`${entry.changed} modified`}</Text> : null}
          <Icon name="chevR" size={16} color={c.faint} stroke={2.2} />
        </Pressable>
      : fileRow(entry.path, entry.path, entry.change, index));
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>{title}</Text>
      {path && listing ? <Text style={styles.crumbs} numberOfLines={1}>{[listing.folder, ...path.split('/')].join(' › ')}</Text> : null}
      <View style={styles.segments} accessibilityRole="tablist">
        {([['all', 'All'], ['changed', changed.length ? `Changed ${changed.length}` : 'Changed'], ['recent', 'Recent']] as Array<[Segment, string]>).map(([key, label]) => (
          <Pressable key={key} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{selected: segment === key}} onPress={() => pick(key)} style={[styles.segment, segment === key && styles.segmentOn]}>
            <Text style={[styles.segmentText, segment === key && styles.segmentTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {segment === 'all' && recent.length ? <>
        <Text style={styles.section}>Opened recently</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel="Opened recently" contentContainerStyle={styles.cards}>
          {recent.slice(0, 6).map(entry => (
            <Pressable key={entry.path} accessibilityRole="button" accessibilityLabel={`${fileName(entry.path)}, opened ${ago(entry.at)}`} onPress={() => onOpenFile(entry.path)} style={({pressed}) => [styles.card, pressed && styles.pressed]}>
              <View style={styles.tile}><Icon name="file" size={16} color={c.accent} stroke={1.9} /></View>
              <Text style={styles.cardName} numberOfLines={1}>{fileName(entry.path)}</Text>
              <Text style={styles.sub}>{ago(entry.at)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </> : null}
      {segment === 'all' ? <Text style={styles.section}>In this folder</Text> : null}
      {rows.length ? <View style={styles.group}>{rows}</View>
        : <Text style={styles.empty}>{!listing && !error ? 'Loading…' : segment === 'changed' ? 'Nothing changed in this folder.' : segment === 'recent' ? 'Files you open show here.' : 'This folder is empty.'}</Text>}
    </ScrollView>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  content: {paddingBottom: 60},
  title: {color: c.text, ...type.largeTitle, paddingHorizontal: space.margin, paddingTop: space.s},
  crumbs: {color: c.muted, ...type.subhead, paddingHorizontal: space.margin, paddingTop: 2},
  segments: {flexDirection: 'row', marginHorizontal: space.card, marginTop: space.l, padding: 3, borderRadius: 12, backgroundColor: c.fill},
  segment: {flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 10},
  segmentOn: {backgroundColor: c.raised},
  segmentText: {color: c.muted, ...type.subhead, fontWeight: '500'},
  segmentTextOn: {color: c.text},
  section: {color: c.muted, ...type.footnote, fontWeight: '600', paddingHorizontal: space.margin, paddingTop: space.xl, paddingBottom: space.s},
  cards: {gap: space.s, paddingHorizontal: space.card},
  card: {width: 112, gap: 6, padding: space.m, borderRadius: radius.well, backgroundColor: c.surface},
  cardName: {color: c.text, ...type.subhead, fontWeight: '600'},
  group: {marginHorizontal: space.card, backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 58, paddingHorizontal: space.l, paddingVertical: 10, backgroundColor: c.surface},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  pressed: {backgroundColor: c.raised},
  tile: {width: 32, height: 32, borderRadius: 8, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center'},
  folderTile: {backgroundColor: c.fill},
  body: {flex: 1, gap: 2},
  name: {color: c.text, ...type.body, fontWeight: '500'},
  sub: {color: c.muted, ...type.footnote},
  word: {...type.subhead, fontWeight: '500'},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin, paddingTop: space.s},
  empty: {color: c.muted, ...type.subhead, paddingHorizontal: space.margin, paddingVertical: space.l},
}));
