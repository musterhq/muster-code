/** A row that answers with a swipe: right past the threshold runs `onRight`, left runs `onLeft`, with a selection haptic as
 *  the threshold is crossed. The row follows the finger on the UI thread and springs back with the shared motion spring. */
import {useRef, type ReactNode} from 'react';
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
  const crossed = useRef(0);
  const pan = usePanGesture({
    testID, runOnJS: true, activeOffsetX: [-12, 12], failOffsetY: [-12, 12],
    onUpdate: event => {
      x.value = event.translationX;
      const side = event.translationX > SWIPE_THRESHOLD ? 1 : event.translationX < -SWIPE_THRESHOLD ? -1 : 0;
      if (side !== crossed.current) { crossed.current = side; if (side) haptics.select(); }
    },
    onDeactivate: event => {
      x.value = withSpring(0, spring);
      crossed.current = 0;
      if (event.translationX > SWIPE_THRESHOLD) onRight();
      else if (event.translationX < -SWIPE_THRESHOLD) onLeft();
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
