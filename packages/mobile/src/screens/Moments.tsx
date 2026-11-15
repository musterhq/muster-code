/** The v3 moments: all clear, paired and a run finishing, plus the lit empty-state art. Each animates once with the bouncy
 *  spring and gives its haptic once; under Reduce Motion they show still. */
import {useEffect} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import Animated, {useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming} from 'react-native-reanimated';
import {Circle, Defs, Path, RadialGradient, Rect, Stop, Svg} from 'react-native-svg';
import {haptics} from '../haptics';
import {springs, useReduceMotion} from '../motion';
import {radius, space, themed, type, useTheme} from '../theme';
import {Button} from '../components/Button';
import {Icon, type IconName} from '../components/Icon';

/** Rings that scale out once from 0.6 with the bouncy spring, around a filled disc with a glyph. */
function Burst({icon, color, size = 180}: {icon: IconName; color: string; size?: number}) {
  const reduce = useReduceMotion();
  const grow = useSharedValue(reduce ? 1 : 0.6);
  useEffect(() => { if (!reduce) grow.value = withSpring(1, springs.bouncy); }, [reduce]);
  const rings = useAnimatedStyle(() => ({transform: [{scale: grow.value}], opacity: Math.min(1, grow.value)}));
  const half = size / 2;
  return (
    <View style={{width: size, height: size, alignItems: 'center', justifyContent: 'center'}} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[StyleSheet.absoluteFill, rings]}>
        <Svg width={size} height={size}>
          <Defs><RadialGradient id="burst" cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor={color} stopOpacity={0.45} /><Stop offset="1" stopColor={color} stopOpacity={0} /></RadialGradient></Defs>
          <Circle cx={half} cy={half} r={half - 2} fill="url(#burst)" />
          <Circle cx={half} cy={half} r={half * 0.76} fill="none" stroke={color} strokeOpacity={0.18} strokeWidth={1.5} />
          <Circle cx={half} cy={half} r={half * 0.6} fill="none" stroke={color} strokeOpacity={0.3} strokeWidth={1.5} />
        </Svg>
      </Animated.View>
      <View style={{width: size * 0.44, height: size * 0.44, borderRadius: size * 0.22, backgroundColor: color, alignItems: 'center', justifyContent: 'center'}}>
        <Icon name={icon} size={size * 0.24} color="#0e1a14" stroke={3} />
      </View>
    </View>
  );
}

/** Answering the last thing that waited (MUS-SPEC-23-24G): the burst, All clear, and what was just answered. */
export function AllClear({answered, celebrate}: {answered: string[]; celebrate: boolean}) {
  const styles = useStyles(), c = useTheme();
  useEffect(() => { if (celebrate) haptics.moment(); }, [celebrate]);
  return (
    <View style={styles.moment} accessibilityLiveRegion="polite">
      {celebrate ? <Burst icon="check" color={c.success} /> : <View style={styles.still}><Icon name="check" size={40} color={c.success} stroke={2.6} /></View>}
      <Text style={styles.title} accessibilityRole="header">All clear</Text>
      <Text style={styles.body}>Agents keep working. You’ll hear from them when they need you.</Text>
      {answered.length ? <View style={styles.receipts}>
        <Text style={styles.section}>Just answered</Text>
        <View style={styles.group}>{answered.map((line, index) => (
          <View key={index} style={[styles.receipt, index > 0 && styles.divider]}><Icon name="check" size={18} color={c.success} stroke={2.4} /><Text style={styles.receiptText} numberOfLines={1}>{line}</Text></View>
        ))}</View>
      </View> : null}
    </View>
  );
}

/** Pairing worked (MUS-SPEC-23-24I): a shield, who can read what passes, and one next step. */
export function PairedMoment({name, onContinue}: {name: string; onContinue(): void}) {
  const styles = useStyles(), c = useTheme();
  useEffect(() => { haptics.success(); }, []);
  return (
    <View style={styles.moment}>
      <Burst icon="shield" color={c.success} />
      <Text style={styles.title} accessibilityRole="header">{`Paired with ${name}`}</Text>
      <Text style={styles.body}>{`Only this phone and ${name} can read what passes between them. The relay carries it, but nobody in between can read it.`}</Text>
      <Text style={styles.note}>It starts watch-only. To send, steer and answer from here, choose Can act for this phone on the computer.</Text>
      <View style={styles.action}><Button label="Continue" kind="primary" onPress={onContinue} /></View>
    </View>
  );
}

/** The live line resolving into a summary when a turn ends (MUS-SPEC-23-24C). */
export function RunFinished({took, files, onReview}: {took: string | null; files: number; onReview?(): void}) {
  const styles = useStyles(), c = useTheme();
  const reduce = useReduceMotion();
  const pulse = useSharedValue(reduce ? 0 : 1);
  useEffect(() => { if (!reduce) pulse.value = withDelay(80, withTiming(0, {duration: 600})); }, [reduce]);
  const ring = useAnimatedStyle(() => ({opacity: pulse.value * 0.6, transform: [{scale: 1 + (1 - pulse.value) * 0.8}]}));
  return (
    <View style={styles.finished} testID="run-finished">
      <View style={styles.tile}>
        <Animated.View style={[styles.pulse, {borderColor: c.success}, ring]} />
        <Icon name="check" size={20} color={c.success} stroke={2.4} />
      </View>
      <View style={styles.finishedBody}>
        <Text style={styles.finishedTitle}>Run finished</Text>
        <View style={styles.subRow}>
          {took ? <Text style={styles.finishedSub}>{`${took} · `}</Text> : null}
          <Text style={styles.finishedSub}>{files === 1 ? '1 file changed' : files ? `${files} files changed` : 'No files changed'}</Text>
        </View>
      </View>
      {files && onReview ? <Button label="Review" kind="tint" small onPress={onReview} /> : null}
    </View>
  );
}

/** The lit illustration for empty screens. */
export function EmptyArt() {
  const c = useTheme();
  return (
    <Svg width={200} height={150} viewBox="0 0 200 150" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs><RadialGradient id="empty" cx="50%" cy="55%" r="55%"><Stop offset="0" stopColor={c.accent} stopOpacity={0.35} /><Stop offset="1" stopColor={c.accent} stopOpacity={0} /></RadialGradient></Defs>
      <Circle cx={100} cy={88} r={80} fill="url(#empty)" />
      <Rect x={36} y={38} width={128} height={84} rx={18} fill={c.raised} stroke={c.glassEdge} />
      <Rect x={52} y={56} width={52} height={8} rx={4} fill={c.accent} opacity={0.9} />
      <Rect x={52} y={72} width={90} height={6} rx={3} fill={c.text} opacity={0.2} />
      <Rect x={52} y={85} width={70} height={6} rx={3} fill={c.text} opacity={0.14} />
      <Circle cx={140} cy={102} r={14} fill={c.accent} />
      <Path d="M140 108v-12M134.5 101.5 140 96l5.5 5.5" stroke={c.onAccent} strokeWidth={2.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const useStyles = themed(c => StyleSheet.create({
  moment: {alignItems: 'center', paddingHorizontal: space.margin, paddingTop: space.xl, gap: space.s},
  still: {width: 80, height: 80, borderRadius: 40, backgroundColor: c.successTint, alignItems: 'center', justifyContent: 'center', marginBottom: space.m},
  title: {color: c.text, ...type.title1, textAlign: 'center'},
  body: {color: c.muted, ...type.body, lineHeight: 24, textAlign: 'center'},
  note: {color: c.muted, ...type.footnote, textAlign: 'center', marginTop: space.s},
  action: {alignSelf: 'stretch', marginTop: space.xl},
  receipts: {alignSelf: 'stretch', marginTop: space.xl},
  section: {color: c.muted, ...type.footnote, fontWeight: '500', paddingHorizontal: space.xs, paddingBottom: space.s},
  group: {backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  receipt: {flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 52, paddingHorizontal: space.l},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  receiptText: {flex: 1, color: c.text, ...type.callout},
  finished: {flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: c.surface, borderRadius: radius.card, padding: space.l, marginTop: space.s},
  tile: {width: 40, height: 40, borderRadius: 12, backgroundColor: c.successTint, alignItems: 'center', justifyContent: 'center'},
  pulse: {position: 'absolute', width: 40, height: 40, borderRadius: 12, borderWidth: 2},
  finishedBody: {flex: 1, gap: 2},
  finishedTitle: {color: c.text, ...type.headline},
  finishedSub: {color: c.muted, ...type.footnote},
  subRow: {flexDirection: 'row', flexWrap: 'wrap'},
}));
