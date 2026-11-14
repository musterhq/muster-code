/**
 * The chat's virtualized list (MUS-SPEC-23-16A). It mounts only the rows near the screen, opens at the newest message, and
 * stays at the end while the reader is there. A reader who scrolled up is left where they are, and a "New" pill offers the
 * way back. The list knows only ids; each row follows its own item, so swapping the list library touches this file only.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent} from 'react-native';
import Animated from 'react-native-reanimated';
import {KeyboardAwareLegendList} from '@legendapp/list/keyboard';
import type {LegendListRef} from '@legendapp/list/react-native';
import type {MobileConnection} from '../shared';
import type {TimelineStore} from '../timeline/store';
import {useTimelineIds} from '../timeline/useTimeline';
import {floatEnter, floatExit} from '../motion';
import {haptics} from '../haptics';
import {space, themed, touch, type} from '../theme';
import {TimelineRow} from './TimelineRow';

/** How close to the end (points) still counts as "reading the newest". */
export const NEAR_END = 120;

export function ChatTimeline({store, connection, canAct, offline}: {store: TimelineStore; connection: MobileConnection; canAct: boolean; /** The computer's name while it is offline: cards wait for it. */ offline?: string}) {
  const styles = useStyles();
  const ids = useTimelineIds(store);
  // The window's size stands in until the list is measured, so the newest rows paint in the first frame.
  const window = useWindowDimensions();
  const list = useRef<LegendListRef>(null);
  const near = useRef(true), seen = useRef(ids.length);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    if (ids.length > seen.current && !near.current) setUnseen(true);
    seen.current = ids.length;
  }, [ids.length]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
    near.current = contentSize.height - contentOffset.y - layoutMeasurement.height < NEAR_END;
    if (near.current) setUnseen(false);
  }, []);
  const toEnd = () => { haptics.select(); setUnseen(false); near.current = true; void list.current?.scrollToEnd({animated: true}); };
  return (
    <View style={styles.wrap}>
      <KeyboardAwareLegendList
        ref={list}
        testID="chat-timeline"
        data={ids as string[]}
        keyExtractor={id => id}
        getItemType={id => store.getItem(id)?.kind ?? 'assistant'}
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
        renderItem={({item: id}) => <View style={styles.row}><TimelineRow store={store} id={id} connection={connection} canAct={canAct} {...(offline ? {offline} : {})} /></View>}
      />
      {unseen ? (
        <Animated.View entering={floatEnter} exiting={floatExit} style={styles.pillWrap} pointerEvents="box-none">
          <Pressable accessibilityRole="button" accessibilityLabel="Jump to new messages" onPress={toEnd} hitSlop={8} style={styles.pill}>
            <Text style={styles.pillText}>New ↓</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  wrap: {flex: 1},
  content: {paddingHorizontal: space.l, paddingVertical: space.m},
  row: {paddingVertical: space.xs},
  pillWrap: {position: 'absolute', bottom: space.m, alignSelf: 'center'},
  pill: {minHeight: touch - 8, paddingHorizontal: space.l, justifyContent: 'center', borderRadius: 18, backgroundColor: c.accentFill},
  pillText: {color: c.onAccent, ...type.label, fontWeight: '600'},
}));
