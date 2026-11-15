/** One file of the chat's folder, read only (v3 File viewer, MUS-SPEC-23-25E): highlighted on the computer and sent in pages,
 *  13 pt code with line numbers, find in a glass field with its count and arrows, and one glass toolbar of icons (text size,
 *  wrap, Show diff for a changed file) with Ask about this as the one labelled action. Binary and too-large files are named,
 *  not shown. */
import {memo, useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {LegendList, type LegendListRef} from '@legendapp/list/react-native';
import type {MobileConnection, MobileFilePage, MobileToken} from '../shared';
import {errorText} from '../hooks';
import {haptics} from '../haptics';
import {Icon} from '../components/Icon';
import {EdgeFade, Glass} from '../components/v3';
import {noteOpened, recentScope} from '../recent';
import {font, space, themed, type, useTheme} from '../theme';

const SIZES = {min: 11, base: 13, max: 20};

const Line = memo(function Line({tokens, at, palette, dark, size, wrap, hit}: {tokens: MobileToken[]; at: number; palette: Array<[string, string]>; dark: boolean; size: number; wrap: boolean; hit: boolean}) {
  const styles = useStyles(), c = useTheme();
  return (
    <View testID={`file-line-${at}`} style={[styles.line, hit && {backgroundColor: c.warningTint}]}>
      <Text style={[styles.number, {fontSize: size - 1, lineHeight: Math.round(size * 1.6)}]}>{String(at + 1)}</Text>
      <Text testID={`file-code-${at}`} style={[styles.code, {fontSize: size, lineHeight: Math.round(size * 1.6)}, !wrap && styles.nowrap]}>
        {tokens.map(([text, color], index) => <Text key={index} style={color !== undefined && palette[color] ? {color: palette[color]![dark ? 0 : 1]} : null}>{text}</Text>)}
      </Text>
    </View>
  );
});

export function FileViewer({connection, chatId, path, onShowDiff, onAsk}: {connection: MobileConnection; chatId: string; path: string; onShowDiff?(path: string): void; onAsk?(path: string): void}) {
  const styles = useStyles(), c = useTheme();
  const [head, setHead] = useState<MobileFilePage | null>(null);
  const [lines, setLines] = useState<MobileToken[][]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<number[] | null>(null);
  const [current, setCurrent] = useState(0);
  const [size, setSize] = useState(SIZES.base);
  const [wrap, setWrap] = useState(true);
  const palette = useRef<Array<[string, string]>>([]);
  const loading = useRef<Promise<number> | null>(null);
  const list = useRef<LegendListRef>(null);
  const loaded = useRef(0);
  /** Loads the page at `from`; resolves to how many lines are held after it. */
  const load = useCallback((from: number): Promise<number> => {
    if (loading.current) return loading.current;
    loading.current = connection.call('files.read', {chatId, path, ...(from ? {from} : {})}).then(page => {
      // Each page numbers its colours from 0: shift them past the colours already held.
      const offset = from === 0 ? 0 : palette.current.length;
      palette.current = from === 0 ? page.palette : [...palette.current, ...page.palette];
      const shifted = offset ? page.lines.map(tokens => tokens.map(([text, color]): MobileToken => color === undefined ? [text] : [text, color + offset])) : page.lines;
      loaded.current = from === 0 ? shifted.length : loaded.current + shifted.length;
      if (from === 0) setHead(page);
      setLines(held => from === 0 ? shifted : [...held, ...shifted]);
      setNext(page.next);
      setError(null);
      return loaded.current;
    }, failure => { setError(errorText(failure)); return loaded.current; }).finally(() => { loading.current = null; });
    return loading.current;
  }, [connection, chatId, path]);
  useEffect(() => { noteOpened(recentScope(connection.deviceId, chatId), path); void load(0); }, [connection, chatId, path]);
  const jump = async (index: number, found = matches) => {
    const line = found?.[index];
    if (line === undefined) return;
    setCurrent(index);
    haptics.select();
    let held = loaded.current, more = next;
    while (line >= held && more !== null) { const before = held; held = await load(held); if (held === before) break; more = held < (head?.total ?? 0) ? held : null; }
    void list.current?.scrollToIndex({index: Math.min(line, held - 1), animated: true, viewPosition: 0.3});
  };
  const find = async () => {
    const text = query.trim();
    if (!text) { setMatches(null); return; }
    try {
      const page = await connection.call('files.read', {chatId, path, query: text});
      const found = page.matches ?? [];
      setMatches(found);
      if (found.length) await jump(0, found); else setCurrent(0);
    } catch (failure) { setError(errorText(failure)); }
  };
  const hits = new Set(matches ?? []);
  const step = (by: number) => { setSize(value => Math.max(SIZES.min, Math.min(SIZES.max, value + by))); haptics.select(); };
  if (head && (head.binary || head.tooLarge)) return (
    <View style={styles.screen}><Text style={styles.note}>{head.binary ? `This file can’t be shown here. Open it on ${connection.desktopName}.` : `This file is too large to show here. Open it on ${connection.desktopName}.`}</Text></View>
  );
  const body = (
    <LegendList
      ref={list}
      testID="file-list"
      data={lines}
      extraData={`${size}:${wrap}:${matches?.join() ?? ''}:${c.scheme}`}
      keyExtractor={(_, index) => String(index)}
      estimatedItemSize={21}
      recycleItems={false}
      onEndReached={() => { if (next !== null) void load(next); }}
      onEndReachedThreshold={1}
      contentContainerStyle={styles.content}
      renderItem={({item, index}) => <Line tokens={item} at={index} palette={palette.current} dark={c.scheme === 'dark'} size={size} wrap={wrap} hit={hits.has(index)} />}
    />
  );
  return (
    <View style={styles.screen}>
      <View style={styles.findRow}>
        <Glass radius={22} style={styles.find}>
          <Icon name="search" size={17} color={c.muted} stroke={2.2} />
          <TextInput accessibilityLabel="Find in file" placeholder="Find" placeholderTextColor={c.faint} value={query} onChangeText={setQuery} onSubmitEditing={() => void find()}
            returnKeyType="search" autoCapitalize="none" autoCorrect={false} style={styles.findInput} />
          {matches ? <Text style={styles.count}>{matches.length ? `${current + 1} of ${matches.length}` : 'No matches'}</Text> : null}
        </Glass>
        <Glass radius={22} style={styles.arrows}>
          <Pressable accessibilityRole="button" accessibilityLabel="Previous match" disabled={!matches?.length || current <= 0} onPress={() => void jump(current - 1)} style={styles.tool}><Icon name="chevU" size={20} color={c.text} stroke={2.4} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Next match" disabled={!matches?.length || current >= matches.length - 1} onPress={() => void jump(current + 1)} style={styles.tool}><Icon name="chevD" size={20} color={c.text} stroke={2.4} /></Pressable>
        </Glass>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {wrap ? body : <ScrollView horizontal contentContainerStyle={styles.wide}>{body}</ScrollView>}
      <EdgeFade edge="bottom" height={120} />
      <Glass radius={30} style={styles.toolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Smaller text" disabled={size <= SIZES.min} onPress={() => step(-1)} style={styles.tool}><Text style={[styles.aa, {fontSize: 13}]}>A</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Larger text" disabled={size >= SIZES.max} onPress={() => step(1)} style={styles.tool}><Text style={[styles.aa, {fontSize: 19}]}>A</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Wrap lines" accessibilityState={{selected: wrap}} onPress={() => { setWrap(value => !value); haptics.select(); }} style={[styles.tool, wrap && {backgroundColor: c.glassSelected}]}><Icon name="wrap" size={20} color={c.text} /></Pressable>
        {head?.change && onShowDiff ? <Pressable accessibilityRole="button" accessibilityLabel="Show diff" onPress={() => onShowDiff(path)} style={styles.tool}><Icon name="diff" size={20} color={c.text} /></Pressable> : null}
        <View style={styles.grow} />
        {onAsk ? <Pressable accessibilityRole="button" accessibilityLabel="Ask about this" onPress={() => onAsk(path)} style={styles.ask}><Icon name="sparkle" size={17} color={c.accent} stroke={2.2} /><Text style={styles.askText}>Ask about this</Text></Pressable> : null}
      </Glass>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  findRow: {flexDirection: 'row', gap: space.s, paddingHorizontal: space.card, paddingVertical: space.s},
  find: {flex: 1, height: 44, flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: 14},
  findInput: {flex: 1, color: c.text, ...type.body, paddingVertical: 0},
  count: {color: c.muted, ...type.footnote},
  arrows: {flexDirection: 'row', height: 44},
  tool: {minWidth: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center'},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin, paddingBottom: space.s},
  note: {color: c.muted, ...type.body, padding: space.margin, textAlign: 'center'},
  content: {paddingBottom: 140, paddingTop: space.xs},
  wide: {minWidth: '100%'},
  line: {flexDirection: 'row', paddingRight: space.m},
  number: {width: 40, paddingRight: 10, textAlign: 'right', color: c.faint, fontFamily: font.mono},
  code: {flex: 1, color: c.text, fontFamily: font.mono},
  nowrap: {flex: 0, flexShrink: 0},
  toolbar: {position: 'absolute', left: space.card, right: space.card, bottom: 34, height: 60, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.s, zIndex: 6},
  aa: {color: c.text, fontWeight: '600'},
  grow: {flex: 1},
  ask: {flexDirection: 'row', alignItems: 'center', gap: 6, height: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: c.accentTint},
  askText: {color: c.accent, ...type.subhead, fontWeight: '600'},
}));
