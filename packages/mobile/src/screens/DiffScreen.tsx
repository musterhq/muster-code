/** One changed file's diff, built for a phone (v3, MUS-SPEC-23-24O/24P). One gutter (the new line number), code at 13 pt that
 *  wraps beside the gutter, hunks named after the function they are in, changed words marked strongly, and one glass toolbar
 *  that follows the focused hunk: previous, "1 of 3", next, Undo and Keep. Kept hunks fold into a pill. Landscape and tablet
 *  widths show the two sides side by side. The computer sends the lines highlighted and in pages; the list is virtualized
 *  and asks for the next page only near its end. */
import {memo, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import {LegendList, type LegendListRef} from '@legendapp/list/react-native';
import type {MobileConnection, MobileDiffLine, MobileDiffPage, MobileHunk, MobileToken} from '../shared';
import {errorText, useAccess} from '../hooks';
import {haptics} from '../haptics';
import {Button} from '../components/Button';
import {Icon} from '../components/Icon';
import {SwipeRow} from '../components/SwipeRow';
import {EdgeFade, Glass} from '../components/v3';
import {font, space, themed, type, useTheme, type Palette} from '../theme';
import {Stat} from './ChangesScreen';

/** Widths from this up show the split diff (a phone in landscape, a tablet). */
export const SPLIT_WIDTH = 600;

type Row = {kind: 'pill'; h: number} | {kind: 'line'; at: number} | {kind: 'pair'; left?: number; right?: number; key: string};
interface Segment { text: string; color?: number; mark: boolean }
/** A line's tokens cut at its changed-word ranges. */
function segments(tokens: MobileToken[], marks: Array<[number, number]> = []): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [text, color] of tokens) {
    let start = 0;
    while (start < text.length) {
      const pos = at + start;
      const inside = marks.find(([from, to]) => pos >= from && pos < to);
      const next = inside ? inside[1] : Math.min(text.length + at, ...marks.map(([from]) => from).filter(from => from > pos));
      const end = Math.min(text.length, next - at);
      out.push({text: text.slice(start, end), ...(color === undefined ? {} : {color}), mark: Boolean(inside)});
      start = end;
    }
    at += text.length;
  }
  return out;
}

const Code = memo(function Code({line, palette, c}: {line: MobileDiffLine; palette: Array<[string, string]>; c: Palette}) {
  const styles = useStyles();
  const mark = line.k === 'a' ? c.addWord : c.delWord;
  return (
    <Text style={styles.code}>
      {segments(line.t, line.w).map((part, index) => (
        <Text key={index} style={[part.color !== undefined && palette[part.color] ? {color: palette[part.color]![c.scheme === 'dark' ? 0 : 1]} : null, part.mark ? {backgroundColor: mark} : null]}>{part.text}</Text>
      ))}
    </Text>
  );
});

function Line({line, at, palette}: {line: MobileDiffLine; at: number; palette: Array<[string, string]>}) {
  const styles = useStyles(), c = useTheme();
  return (
    <View testID={`line-${at}`} style={[styles.line, line.k === 'a' && {backgroundColor: c.addBg}, line.k === 'd' && {backgroundColor: c.delBg}]}>
      <Text style={styles.number}>{line.k === 'd' ? '' : String(line.n ?? '')}</Text>
      <Text style={[styles.sign, line.k === 'a' && {color: c.success}, line.k === 'd' && {color: c.danger}]}>{line.k === 'a' ? '+' : line.k === 'd' ? '−' : ' '}</Text>
      <Code line={line} palette={palette} c={c} />
    </View>
  );
}

function Half({line, side, palette, testID}: {line?: MobileDiffLine; side: 'old' | 'new'; palette: Array<[string, string]>; testID: string}) {
  const styles = useStyles(), c = useTheme();
  if (!line) return <View testID={testID} style={[styles.half, {backgroundColor: c.surface}]} />;
  const tint = line.k === 'a' ? c.addBg : line.k === 'd' ? c.delBg : undefined;
  return (
    <View testID={testID} style={[styles.half, tint ? {backgroundColor: tint} : null]}>
      <Text style={styles.number}>{String((side === 'old' ? line.old : line.n) ?? '')}</Text>
      <Code line={line} palette={palette} c={c} />
    </View>
  );
}

/** Inline rows (a pill per hunk, then its lines) or split rows (removed beside added). Kept hunks show their pill only. */
function rowsOf(lines: MobileDiffLine[], hunks: MobileHunk[], split: boolean): Row[] {
  const rows: Row[] = [];
  let hunk = -1;
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    if (line.h !== hunk) { hunk = line.h; rows.push({kind: 'pill', h: hunk}); }
    if (hunks[hunk]?.state === 'kept') continue;
    if (!split) { rows.push({kind: 'line', at}); continue; }
    if (line.k === 'c') { rows.push({kind: 'pair', left: at, right: at, key: `p${at}`}); continue; }
    // A run of removed lines, then a run of added ones, side by side.
    const removed: number[] = [], added: number[] = [];
    while (at < lines.length && lines[at]!.h === hunk && lines[at]!.k === 'd') removed.push(at++);
    while (at < lines.length && lines[at]!.h === hunk && lines[at]!.k === 'a') added.push(at++);
    at--;
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      const left = removed[index], right = added[index];
      rows.push({kind: 'pair', ...(left === undefined ? {} : {left}), ...(right === undefined ? {} : {right}), key: `p${left ?? 'x'}-${right ?? 'x'}`});
    }
  }
  return rows;
}

export function DiffScreen({connection, chatId, path, width: given}: {connection: MobileConnection; chatId: string; path: string; width?: number}) {
  const styles = useStyles(), c = useTheme();
  const window = useWindowDimensions();
  const width = given ?? window.width;
  const split = width >= SPLIT_WIDTH;
  const canAct = useAccess(connection) === 'act';
  const [page, setPage] = useState<MobileDiffPage | null>(null);
  const [lines, setLines] = useState<MobileDiffLine[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const loading = useRef(false);
  const colours = useRef<Array<[string, string]>>([]);
  const list = useRef<LegendListRef>(null);
  const load = useCallback(async (from: number) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const result = await connection.call('changes.diff', {chatId, path, from});
      // Each page numbers its colours from 0: shift them past the colours already held.
      const offset = from === 0 ? 0 : colours.current.length;
      colours.current = from === 0 ? result.palette : [...colours.current, ...result.palette];
      const shifted = offset ? result.lines.map(line => ({...line, t: line.t.map(([text, color]): MobileToken => color === undefined ? [text] : [text, color + offset])})) : result.lines;
      setPage({...result, palette: colours.current});
      setLines(current => from === 0 ? shifted : [...current, ...shifted]);
      setNext(result.next);
      setError(null);
    } catch (failure) { setError(errorText(failure)); } finally { loading.current = false; }
  }, [connection, chatId, path]);
  useEffect(() => { void load(0); }, [connection, chatId, path]);
  const hunks = page?.hunks ?? [];
  const rows = useMemo(() => rowsOf(lines, hunks, split), [lines, hunks, split]);
  const focused = hunks[Math.min(focus, Math.max(0, hunks.length - 1))];
  const move = (to: number) => {
    if (to < 0 || to >= hunks.length) return;
    haptics.select(); setFocus(to);
    const index = rows.findIndex(row => row.kind === 'pill' && row.h === to);
    if (index >= 0) void list.current?.scrollToIndex({index, animated: true});
  };
  const keep = async (h = focus) => {
    const hunk = hunks[h];
    if (!page || !hunk || busy) return;
    setBusy(true);
    try {
      await connection.call('changes.keep', {chatId, runId: page.runId, path, hunkIds: [hunk.id]});
      haptics.success();
      setPage(current => current && {...current, hunks: current.hunks.map((entry, index): MobileHunk => index === h ? {...entry, state: 'kept'} : entry)});
      const after = hunks.findIndex((entry, index) => index > h && entry.state !== 'kept');
      if (after >= 0) setFocus(after);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  const undo = async (h = focus) => {
    const hunk = hunks[h];
    if (!page || !hunk || busy) return;
    setBusy(true);
    try {
      const {stale} = await connection.call('changes.undo', {chatId, runId: page.runId, path, afterHash: page.afterHash, ...(hunk.id === '*' ? {} : {hunkId: hunk.id})});
      haptics.warning();
      if (stale) setError('This file changed on the computer after you read it, so nothing was undone. Here it is again.');
      loading.current = false;
      await load(0);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  const total = page?.total ?? 0;
  /** The next page, when the reader nears the end of what is loaded. */
  const more = () => { if (next !== null) void load(next); };
  const pill = (h: number) => {
    const hunk = hunks[h];
    if (!hunk) return null;
    const name = hunk.fn ? `in ${hunk.fn}` : hunks.length > 1 ? `Change ${h + 1}` : 'The change';
    if (hunk.state === 'kept') return <View style={styles.pillRow}><View style={[styles.pill, {backgroundColor: c.successTint}]}><Icon name="check" size={14} color={c.success} stroke={2.6} /><Text style={[styles.pillText, {color: c.success}]}>{`Kept · ${name}`}</Text></View></View>;
    const on = h === focus;
    const content = (
      <Pressable accessibilityRole="button" accessibilityLabel={`${name}, change ${h + 1} of ${hunks.length}`} onPress={() => move(h)} style={styles.pillRow}>
        <View style={[styles.pill, {backgroundColor: on ? c.accentTint : c.raised}]}><Icon name="chevR" size={12} color={on ? c.accent : c.muted} stroke={2.6} /><Text style={[styles.pillText, {color: on ? c.accent : c.muted}]}>{name}</Text></View>
        <Text style={styles.pillMeta}>{`Change ${h + 1} of ${hunks.length}`}</Text>
      </Pressable>
    );
    return canAct ? <SwipeRow testID={`swipe-hunk-${hunk.id}`} rightLabel="Keep" leftLabel="Undo" onRight={() => void keep(h)} onLeft={() => void undo(h)}>{content}</SwipeRow> : content;
  };
  if (page && (page.binary || page.tooLarge)) return <View style={styles.screen}><Text style={styles.note}>{page.binary ? `This is a binary file. Open it on ${connection.desktopName}.` : `Too large to show here. Open it on ${connection.desktopName}.`}</Text></View>;
  return (
    <View style={styles.screen}>
      {page ? <View style={styles.head}>
        <Stat adds={page.adds} dels={page.dels} />
        <Text style={styles.headText}>{hunks.length === 1 ? '1 change' : `${hunks.length} changes`}</Text>
        <View style={styles.grow} />
        {hunks.some(hunk => hunk.state === 'kept') ? <Text style={styles.headText}>{`${hunks.filter(hunk => hunk.state === 'kept').length} kept`}</Text> : null}
      </View> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <LegendList
        ref={list}
        testID="diff-list"
        data={rows}
        extraData={`${focus}:${hunks.map(hunk => hunk.state).join()}:${c.scheme}`}
        keyExtractor={row => row.kind === 'pill' ? `h${row.h}` : row.kind === 'line' ? `l${row.at}` : row.key}
        getItemType={row => row.kind}
        estimatedItemSize={24}
        recycleItems={false}
        onEndReached={more}
        onEndReachedThreshold={1}
        onScroll={event => { const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent; if (contentSize.height - contentOffset.y - layoutMeasurement.height < layoutMeasurement.height * 2) more(); }}
        scrollEventThrottle={64}
        contentContainerStyle={styles.content}
        ListFooterComponent={<Text style={styles.footer} accessibilityLabel={`${lines.length} of ${total} lines`}>{next !== null ? `Showing ${lines.length} of ${total} lines` : ' '}</Text>}
        renderItem={({item: row, index}) => row.kind === 'pill' ? pill(row.h)
          : row.kind === 'line' ? <Line line={lines[row.at]!} at={row.at} palette={page?.palette ?? []} />
          : <View testID={`split-${index - rows.slice(0, index + 1).filter(entry => entry.kind === 'pill').length}`} style={styles.pair}>
              <Half line={row.left === undefined ? undefined : lines[row.left]} side="old" palette={page?.palette ?? []} testID="split-left" />
              <View style={styles.seam} />
              <Half line={row.right === undefined ? undefined : lines[row.right]} side="new" palette={page?.palette ?? []} testID="split-right" />
            </View>}
      />
      <EdgeFade edge="bottom" height={130} />
      {hunks.length ? <Glass radius={30} style={styles.toolbar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous change" disabled={focus <= 0} onPress={() => move(focus - 1)} style={styles.tool}><Icon name="chevU" size={22} color={focus <= 0 ? c.faint : c.text} stroke={2.4} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Next change" disabled={focus >= hunks.length - 1} onPress={() => move(focus + 1)} style={styles.tool}><Icon name="chevD" size={22} color={focus >= hunks.length - 1 ? c.faint : c.text} stroke={2.4} /></Pressable>
        <Text style={styles.position}>{`${Math.min(focus, hunks.length - 1) + 1} of ${hunks.length}`}</Text>
        <View style={styles.grow} />
        {canAct && focused && focused.state !== 'kept' ? <>
          <Button label="Undo" icon="undo" small busy={busy} onPress={() => void undo()} />
          <Button label="Keep" icon="check" kind="primary" small disabled={busy} onPress={() => void keep()} />
        </> : null}
      </Glass> : null}
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  head: {flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.margin, paddingVertical: space.m},
  headText: {color: c.muted, ...type.subhead},
  grow: {flex: 1},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin, paddingBottom: space.s},
  note: {color: c.muted, ...type.body, padding: space.margin, textAlign: 'center'},
  content: {paddingBottom: 140},
  pillRow: {flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.l, paddingTop: space.m, paddingBottom: space.s, backgroundColor: c.background},
  pill: {flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, borderRadius: 15, paddingHorizontal: 11},
  pillText: {fontSize: 13, lineHeight: 18, fontWeight: '600', fontFamily: font.mono},
  pillMeta: {color: c.faint, ...type.footnote},
  line: {flexDirection: 'row', paddingRight: space.m},
  number: {width: 38, paddingRight: 10, textAlign: 'right', color: c.faint, fontSize: 12, lineHeight: 21, fontFamily: font.mono},
  sign: {width: 14, color: c.faint, ...type.code},
  code: {flex: 1, color: c.text, ...type.code},
  pair: {flexDirection: 'row'},
  half: {flex: 1, flexDirection: 'row', paddingRight: space.s},
  seam: {width: StyleSheet.hairlineWidth, backgroundColor: c.border},
  footer: {color: c.muted, ...type.footnote, textAlign: 'center', paddingVertical: space.m},
  toolbar: {position: 'absolute', left: space.card, right: space.card, bottom: 34, height: 60, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.s, zIndex: 6},
  tool: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  position: {color: c.muted, ...type.subhead},
}));
