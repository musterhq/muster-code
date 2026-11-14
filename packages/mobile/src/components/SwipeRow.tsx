/** A row that answers with a swipe: right past the threshold runs `onRight`, left runs `onLeft`, with a selection haptic as
 *  the threshold is crossed. The gesture callbacks are worklets (#326 phase 4): the row follows the finger and springs back
 *  on the UI thread, and only the haptic and the answer cross to JavaScript. */
import {type ReactNode} from 'react';
import {scheduleOnRN} from 'react-native-worklets';
import {StyleSheet, Text, View} from 'react-native';
import {GestureDetector, usePanGesture} from 'react-native-gesture-handler';
import Animated, {useAnimatedStyle, useSharedValue, withSpring} from 'react-native-reanimated';
import {haptics} from '../haptics';
import {spring} from '../motion';
import {space, themed, type} from '../theme';

export const SWIPE_THRESHOLD = 96;

export function SwipeRow({testID, children, rightLabel, leftLabel, onRight, onLeft}: {testID: string; children: ReactNode; rightLabel: string; leftLabel: string; onRight(): void; onLeft(): void}) {
  const styles = useStyles();
  const x = useSharedValue(0);
  const crossed = useSharedValue(0);
  const pan = usePanGesture({
    testID, activeOffsetX: [-12, 12], failOffsetY: [-12, 12],
    onUpdate: event => {
      'worklet';
      x.value = event.translationX;
      const side = event.translationX > SWIPE_THRESHOLD ? 1 : event.translationX < -SWIPE_THRESHOLD ? -1 : 0;
      if (side !== crossed.value) { crossed.value = side; if (side) scheduleOnRN(haptics.select); }
    },
    onDeactivate: event => {
      'worklet';
      x.value = withSpring(0, spring);
      crossed.value = 0;
      if (event.translationX > SWIPE_THRESHOLD) scheduleOnRN(onRight);
      else if (event.translationX < -SWIPE_THRESHOLD) scheduleOnRN(onLeft);
    },
  });
  const moving = useAnimatedStyle(() => ({transform: [{translateX: x.value}]}));
  return (
    <View style={styles.wrap}>
      <View style={styles.under} pointerEvents="none">
        <View style={[styles.side, styles.right]}><Text style={styles.label}>{rightLabel}</Text></View>
        <View style={[styles.side, styles.left]}><Text style={styles.label}>{leftLabel}</Text></View>
      </View>
      <GestureDetector gesture={pan}><Animated.View style={moving}>{children}</Animated.View></GestureDetector>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  wrap: {position: 'relative'},
  under: {...StyleSheet.absoluteFill, flexDirection: 'row', borderRadius: 12, overflow: 'hidden'},
  side: {flex: 1, justifyContent: 'center', paddingHorizontal: space.xl},
  right: {backgroundColor: c.success},
  left: {backgroundColor: c.danger, alignItems: 'flex-end'},
  label: {color: '#ffffff', ...type.footnote, fontWeight: '600'},
}));
