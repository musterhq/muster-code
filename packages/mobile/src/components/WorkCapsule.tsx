/** A turn's tool steps and thinking folded into one capsule (v3): "Working · N steps" while a step runs, "Worked 2m 14s ·
 *  N steps" after. Tapping it opens the steps, each a plain sentence with its status. */
import {memo, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Animated from 'react-native-reanimated';
import type {MobileItem} from '../shared';
import type {TimelineStore} from '../timeline/store';
import {useTimelineItems} from '../timeline/useTimeline';
import {haptics} from '../haptics';
import {rowLayout} from '../motion';
import {reportRender} from '../perf';
import {radius, space, themed, type, useTheme} from '../theme';
import {Icon, type IconName} from './Icon';
import {Spinner} from './v3';

const FINISHED = new Set(['completed', 'failed', 'declined', 'cancelled', 'interrupted']);
/** A step still running: a tool whose status is set and not finished. */
export const stepRunning = (item: MobileItem): boolean => item.kind === 'tool' && Boolean(item.status) && !FINISHED.has(item.status!);
/** "2m 14s", "45s", "1h 3m". */
export function took(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
const stepIcon = (item: MobileItem): IconName => item.kind === 'reasoning' ? 'sparkle' : /^(edit|wrote|write|creat|patch|apply)/i.test(item.text) ? 'diff' : /^(run|ran|exec|\$)/i.test(item.text) ? 'term' : 'file';

export const WorkCapsule = memo(function WorkCapsule({store, id, ids, since, running}: {store: TimelineStore; id: string; ids: readonly string[]; since: string | null; running: boolean}) {
  const styles = useStyles(), c = useTheme();
  const items = useTimelineItems(store, ids);
  const [open, setOpen] = useState(false);
  reportRender('timeline-row', id);
  const working = running && items.some(stepRunning);
  const last = items[items.length - 1];
  const start = since ?? items[0]?.createdAt;
  const span = start && last ? Date.parse(last.createdAt) - Date.parse(start) : 0;
  const label = working ? 'Working' : span >= 1000 ? `Worked ${took(span)}` : 'Worked';
  const steps = items.length === 1 ? '1 step' : `${items.length} steps`;
  const failed = items.some(item => item.status === 'failed');
  return (
    <Animated.View layout={rowLayout} style={[styles.wrap, open && styles.open]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${steps}`} accessibilityState={{expanded: open}} onPress={() => { haptics.select(); setOpen(value => !value); }} style={styles.capsule}>
        {working ? <Spinner size={22} color={c.accent} track={c.accentTint2} stroke={2.4} /> : <Icon name={failed ? 'alert' : 'check'} size={22} color={failed ? c.danger : c.success} stroke={2.2} />}
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.steps}>{steps}</Text>
        <Icon name={open ? 'chevU' : 'chevD'} size={16} color={c.muted} stroke={2.4} />
      </Pressable>
      {open ? <View style={styles.list}>
        {items.map(item => (
          <View key={item.id} style={styles.step}>
            <Icon name={stepIcon(item)} size={18} color={item.status === 'failed' ? c.danger : c.muted} stroke={1.9} />
            <View style={styles.stepBody}>
              <Text style={styles.stepText} numberOfLines={item.kind === 'reasoning' ? 4 : 2}>{item.kind === 'reasoning' ? 'Thinking' : item.text}</Text>
              {item.kind === 'reasoning' ? <Text style={styles.detail} numberOfLines={3}>{item.text}</Text> : item.status && item.status !== 'completed' ? <Text style={[styles.detail, item.status === 'failed' && {color: c.danger}]}>{stepRunning(item) ? 'Running' : item.status}</Text> : null}
            </View>
          </View>
        ))}
      </View> : null}
    </Animated.View>
  );
});
const useStyles = themed(c => StyleSheet.create({
  wrap: {alignSelf: 'flex-start', maxWidth: '100%', backgroundColor: c.surface, borderRadius: 22},
  open: {alignSelf: 'stretch', borderRadius: radius.card},
  capsule: {flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingLeft: space.m, paddingRight: 14},
  label: {color: c.text, ...type.subhead, fontWeight: '500'},
  steps: {color: c.muted, ...type.subhead},
  list: {paddingHorizontal: space.l, paddingBottom: space.m, gap: space.m},
  step: {flexDirection: 'row', gap: space.m, alignItems: 'flex-start'},
  stepBody: {flex: 1, gap: 2},
  stepText: {color: c.text, ...type.subhead},
  detail: {color: c.muted, ...type.footnote},
}));
