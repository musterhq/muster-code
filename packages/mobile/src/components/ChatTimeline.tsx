/**
 * The chat's virtualized list (MUS-SPEC-23-16A). It mounts only the rows near the screen, opens at the newest message, and
 * stays at the end while the reader is there. A reader who scrolled up is left where they are, and a "New" pill offers the
 * way back. The list knows only ids; each row follows its own item, so swapping the list library touches this file only.
 *
 * v3 (MUS-SPEC-23-24C): a turn's consecutive tool steps and thinking fold into one work capsule; while the turn runs, the live
 * line under the newest row says what the agent is doing now and the streaming reply ends with the caret; when it ends, the
 * live line resolves into the run's summary.
 */
import {useCallback, useEffect, useMemo, useRef, useState, type ReactElement} from 'react';
import {Pressable, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent} from 'react-native';
import Animated from 'react-native-reanimated';
import {KeyboardAwareLegendList} from '@legendapp/list/keyboard';
import type {LegendListRef} from '@legendapp/list/react-native';
import type {MobileConnection, MobileItem} from '../shared';
import type {TimelineStore} from '../timeline/store';
import {useTimelineIds, useTimelineItems} from '../timeline/useTimeline';
import {floatEnter, floatExit} from '../motion';
import {haptics} from '../haptics';
import {space, themed, touch, type} from '../theme';
import {TimelineRow} from './TimelineRow';
import {stepRunning, WorkCapsule} from './WorkCapsule';
import {Glass, Shimmer, StatusGlyph} from './v3';

/** How close to the end (points) still counts as "reading the newest". */
export const NEAR_END = 120;
const STEP = new Set(['tool', 'reasoning']);
const WORK = 'work:';

/** Rows of the list: an item's id, or a work group keyed by its first step, with the turn's start for its duration. */
interface Group { ids: string[]; since: string | null }
function grouping(store: TimelineStore, ids: readonly string[]): {rows: string[]; groups: Map<string, Group>} {
  const rows: string[] = [], groups = new Map<string, Group>();
  let current: Group | null = null, since: string | null = null;
  for (const id of ids) {
    const item = store.getItem(id);
    if (item?.kind === 'user') since = item.createdAt;
    if (item && STEP.has(item.kind)) {
      if (!current) { current = {ids: [], since}; groups.set(WORK + id, current); rows.push(WORK + id); }
      current.ids.push(id);
    } else { current = null; rows.push(id); }
  }
  return {rows, groups};
}
/** What the agent is doing now, in plain words. */
function nowStep(store: TimelineStore, ids: readonly string[]): string {
  for (let index = ids.length - 1; index >= 0 && index >= ids.length - 40; index--) {
    const item = store.getItem(ids[index]!);
    if (item && stepRunning(item)) return item.text.split('\n')[0]!;
  }
  const last = ids.length ? store.getItem(ids[ids.length - 1]!) : undefined;
  return last?.kind === 'reasoning' ? 'Thinking' : last?.kind === 'assistant' ? 'Writing' : 'Working';
}

export function ChatTimeline({store, connection, canAct, offline, running = false, footer}: {store: TimelineStore; connection: MobileConnection; canAct: boolean; /** The computer's name while it is offline: cards wait for it. */ offline?: string; /** A turn is running: show the live line and the caret. */ running?: boolean; /** Below the newest row when no turn runs (the run's summary). */ footer?: ReactElement | null}) {
  const styles = useStyles();
  const ids = useTimelineIds(store);
  const {rows, groups} = useMemo(() => grouping(store, ids), [store, ids]);
  const lastId = ids[ids.length - 1];
  const liveId = running && lastId && store.getItem(lastId)?.kind === 'assistant' ? lastId : null;
  // The window's size stands in until the list is measured, so the newest rows paint in the first frame.
  const window = useWindowDimensions();
  const list = useRef<LegendListRef>(null);
  const near = useRef(true), seen = useRef(rows.length);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    if (rows.length > seen.current && !near.current) setUnseen(true);
    seen.current = rows.length;
  }, [rows.length]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
    near.current = contentSize.height - contentOffset.y - layoutMeasurement.height < NEAR_END;
    if (near.current) setUnseen(false);
  }, []);
  const toEnd = () => { haptics.select(); setUnseen(false); near.current = true; void list.current?.scrollToEnd({animated: true}); };
  const live = running && !offline ? <LiveLine store={store} ids={ids} /> : null;
  return (
    <View style={styles.wrap}>
      <KeyboardAwareLegendList
        ref={list}
        testID="chat-timeline"
        data={rows}
        extraData={`${liveId}:${running}`}
        keyExtractor={id => id}
        getItemType={id => id.startsWith(WORK) ? 'work' : store.getItem(id)?.kind ?? 'assistant'}
        estimatedItemSize={56}
        estimatedListSize={{width: window.width, height: window.height}}
        recycleItems={false}
        initialScrollAtEnd
        alignItemsAtEnd
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.15}
        onScroll={onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={styles.content}
        ListFooterComponent={live ?? footer ?? null}
        renderItem={({item: id}) => <View style={styles.row}>{id.startsWith(WORK)
          ? <WorkCapsule store={store} id={id} ids={groups.get(id)!.ids} since={groups.get(id)!.since} running={running} />
          : <TimelineRow store={store} id={id} connection={connection} canAct={canAct} live={id === liveId} {...(offline ? {offline} : {})} />}</View>}
      />
      {unseen ? (
        <Animated.View entering={floatEnter} exiting={floatExit} style={styles.pillWrap} pointerEvents="box-none">
          <Glass radius={18}>
            <Pressable accessibilityRole="button" accessibilityLabel="Jump to new messages" onPress={toEnd} hitSlop={8} style={styles.pill}>
              <Text style={styles.pillText}>New ↓</Text>
            </Pressable>
          </Glass>
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The live line: a running glyph and the step in plain words, shimmering. */
function LiveLine({store, ids}: {store: TimelineStore; ids: readonly string[]}) {
  const styles = useStyles();
  // Follows the newest rows, so the line moves on when a step finishes.
  useTimelineItems(store, ids.slice(-40));
  const step = nowStep(store, ids);
  return (
    <View style={styles.live} testID="now-line" accessibilityLiveRegion="polite" accessibilityLabel={`Now: ${step}`}>
      <StatusGlyph kind="running" size={24} />
      <Shimmer text={step} style={styles.liveText} />
    </View>
  );
}

/** The duration of the newest work group, for the run's summary. */
export function lastWorkSpan(store: TimelineStore): number | null {
  const ids = store.getIds();
  let since: string | null = null, first: MobileItem | undefined, last: MobileItem | undefined;
  for (const id of ids) {
    const item = store.getItem(id);
    if (!item) continue;
    if (item.kind === 'user') { since = item.createdAt; first = undefined; last = undefined; }
    else if (STEP.has(item.kind)) { first ??= item; last = item; }
  }
  const start = since ?? first?.createdAt;
  return start && last ? Date.parse(last.createdAt) - Date.parse(start) : null;
}

const useStyles = themed(c => StyleSheet.create({
  wrap: {flex: 1},
  content: {paddingHorizontal: space.margin, paddingVertical: space.m},
  row: {paddingVertical: 7},
  live: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: space.s},
  liveText: {...type.subhead, fontWeight: '500', flexShrink: 1},
  pillWrap: {position: 'absolute', bottom: space.m, alignSelf: 'center'},
  pill: {minHeight: touch - 8, paddingHorizontal: space.l, justifyContent: 'center'},
  pillText: {color: c.text, ...type.subhead, fontWeight: '600'},
}));
