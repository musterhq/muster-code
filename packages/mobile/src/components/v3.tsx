/** The v3 building blocks: the glass material, scroll-edge fades, status glyphs, the review ring, the streaming caret and the
 *  live line's shimmer. Every loop stops under Reduce Motion. */
import {useEffect, type ReactNode} from 'react';
import {Platform, StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle} from 'react-native';
import {BlurView} from 'expo-blur';
import {GlassView, isLiquidGlassAvailable} from 'expo-glass-effect';
import Animated, {cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming} from 'react-native-reanimated';
import {Circle, Defs, LinearGradient, Rect, Stop, Svg} from 'react-native-svg';
import type {MobileChatStatus} from '../shared';
import {CARET_BLINK_MS, SHIMMER_MS, useReduceMotion} from '../motion';
import {useTheme, type Palette} from '../theme';
import {Icon, type IconName} from './Icon';

const liquidGlass = (() => { try { return Platform.OS === 'ios' && isLiquidGlassAvailable(); } catch { return false; } })();

/** Glass: iOS 26 Liquid Glass, else a blur under the v3 glass tint with its top-edge highlight; on Android a tonal surface. */
export function Glass({style, radius, children, testID}: {style?: StyleProp<ViewStyle>; radius: number; children?: ReactNode; testID?: string}) {
  const c = useTheme();
  if (liquidGlass) return <GlassView testID={testID} glassEffectStyle="regular" style={[style, {borderRadius: radius, overflow: 'hidden'}]}>{children}</GlassView>;
  const edge = {borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassEdge, borderTopColor: c.glassHighlight};
  if (Platform.OS === 'ios') return (
    <View testID={testID} style={[style, edge, {overflow: 'hidden', backgroundColor: c.glass}]}>
      <BlurView intensity={40} tint={c.scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'} style={StyleSheet.absoluteFill} />
      {children}
    </View>
  );
  return <View testID={testID} style={[style, edge, {backgroundColor: c.raised, elevation: 3}]}>{children}</View>;
}

/** The 120 pt fade from the canvas under a nav bar (top) or a tab bar or toolbar (bottom). */
export function EdgeFade({edge, height = 120}: {edge: 'top' | 'bottom'; height?: number}) {
  const c = useTheme();
  const id = `fade-${edge}`;
  return (
    <View pointerEvents="none" style={[styles.fade, edge === 'top' ? {top: 0} : {bottom: 0}, {height}]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1={edge === 'top' ? '0' : '1'} x2="0" y2={edge === 'top' ? '1' : '0'}>
            <Stop offset="0" stopColor={c.background} stopOpacity={1} />
            <Stop offset="0.55" stopColor={c.background} stopOpacity={0.8} />
            <Stop offset="1" stopColor={c.background} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

export type GlyphKind = 'running' | 'waiting' | 'question' | 'failed' | 'done' | 'idle' | 'queued';
/** The words a glyph stands for, for screen readers and the colour-coded lead of a chat row. */
export const GLYPH_WORD: Record<GlyphKind, string> = {running: 'Running', waiting: 'Needs you', question: 'Asks a question', failed: 'Failed', done: 'Done', idle: 'Idle', queued: 'Was running'};
export const glyphOf = (status: MobileChatStatus, offline = false): GlyphKind =>
  offline && (status === 'running' || status === 'stopping') ? 'queued'
    : status === 'running' || status === 'stopping' ? 'running' : status === 'waiting' ? 'waiting' : status === 'failed' ? 'failed' : status === 'completed' ? 'done' : 'idle';
export const glyphColor = (c: Palette, kind: GlyphKind): string =>
  kind === 'running' || kind === 'question' ? c.accent : kind === 'waiting' ? c.warning : kind === 'failed' ? c.danger : kind === 'done' ? c.success : kind === 'queued' ? c.muted : c.faint;
const GLYPH_ICON: Partial<Record<GlyphKind, IconName>> = {waiting: 'hand', question: 'chats', failed: 'alert', done: 'check', queued: 'clock'};

/** A status glyph: a tile tinted in the state's hue with a shape that differs per state (running ring, amber hand, accent
 *  bubble, red triangle, green check, dashed idle ring, clock for queued). */
export function StatusGlyph({kind, size = 36}: {kind: GlyphKind; size?: number}) {
  const c = useTheme();
  const color = glyphColor(c, kind);
  const label = GLYPH_WORD[kind];
  if (kind === 'running') return <View accessible accessibilityLabel={label} testID="glyph-running"><Spinner size={size} color={color} tint={c.accentTint} track={c.accentTint2} /></View>;
  if (kind === 'idle') {
    const r = size / 2 - 2;
    return <View accessible accessibilityLabel={label}><Svg width={size} height={size}><Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={1.8} strokeDasharray="3.2 3.4" /></Svg></View>;
  }
  const tint = kind === 'waiting' ? c.warningTint : kind === 'failed' ? c.dangerTint : kind === 'done' ? c.successTint : kind === 'queued' ? c.fill : c.accentTint;
  return (
    <View accessible accessibilityLabel={label} style={{width: size, height: size, borderRadius: size / 2, backgroundColor: tint, alignItems: 'center', justifyContent: 'center'}}>
      <Icon name={GLYPH_ICON[kind]!} size={size * 0.56} color={color} stroke={2.1} />
    </View>
  );
}

/** A ring with a turning arc (the running glyph, and the ring around Stop). */
export function Spinner({size, color, tint, track, stroke = 2.6}: {size: number; color: string; tint?: string; track?: string; stroke?: number}) {
  const reduce = useReduceMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    turn.value = withRepeat(withTiming(360, {duration: 1100, easing: Easing.linear}), -1, false);
    return () => cancelAnimation(turn);
  }, [reduce]);
  const spin = useAnimatedStyle(() => ({transform: [{rotate: `${turn.value}deg`}]}));
  const r = size / 2 - stroke, length = 2 * Math.PI * r;
  return (
    <View style={{width: size, height: size}}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        {tint ? <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={tint} /> : null}
        {track ? <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} /> : null}
        {tint ? <Circle cx={size / 2} cy={size / 2} r={size * 0.1} fill={color} /> : null}
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, spin]}>
        <Svg width={size} height={size}><Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${length * 0.28} ${length}`} /></Svg>
      </Animated.View>
    </View>
  );
}

/** The review ring: how much of something is done (0 to 1). */
export function ProgressRing({value, size = 32, label}: {value: number; size?: number; label?: string}) {
  const c = useTheme();
  const r = size / 2 - 3, length = 2 * Math.PI * r, done = Math.max(0, Math.min(1, value));
  return (
    <View accessible={Boolean(label)} accessibilityLabel={label} accessibilityRole={label ? 'progressbar' : undefined} accessibilityValue={{min: 0, max: 100, now: Math.round(done * 100)}}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={c.accentTint} />
        <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={c.accentTint2} strokeWidth={3} />
        <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={c.accent} strokeWidth={3} strokeLinecap="round" strokeDasharray={`${length * done} ${length}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
    </View>
  );
}

/** The streaming caret: 9 pt in the accent with a 12 pt glow, blinking every 1.1 s (steady under Reduce Motion). */
export function Caret() {
  const c = useTheme();
  const reduce = useReduceMotion();
  const shown = useSharedValue(1);
  useEffect(() => {
    if (reduce) return;
    shown.value = withRepeat(withSequence(withTiming(1, {duration: CARET_BLINK_MS / 2}), withTiming(0, {duration: 0}), withTiming(0, {duration: CARET_BLINK_MS / 2}), withTiming(1, {duration: 0})), -1, false);
    return () => cancelAnimation(shown);
  }, [reduce]);
  const blink = useAnimatedStyle(() => ({opacity: shown.value}));
  return <Animated.View testID="caret" style={[{width: 9, height: 19, borderRadius: 3, backgroundColor: c.accent, shadowColor: c.accent, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: {width: 0, height: 0}, marginTop: 2}, blink]} />;
}

/** The live line's text: it brightens and dims once every 2.2 s, a single text so readers meet it once (still under Reduce
 *  Motion). */
export function Shimmer({text, style}: {text: string; style: StyleProp<TextStyle>}) {
  const c = useTheme();
  const reduce = useReduceMotion();
  const lit = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    lit.value = withRepeat(withSequence(withTiming(1, {duration: SHIMMER_MS / 2, easing: Easing.inOut(Easing.quad)}), withTiming(0, {duration: SHIMMER_MS / 2, easing: Easing.inOut(Easing.quad)})), -1, false);
    return () => cancelAnimation(lit);
  }, [reduce]);
  const glow = useAnimatedStyle(() => ({opacity: 0.72 + lit.value * 0.28}));
  return <Animated.Text style={[style, {color: c.text}, glow]} numberOfLines={1}>{text}</Animated.Text>;
}

const styles = StyleSheet.create({
  fade: {position: 'absolute', left: 0, right: 0, zIndex: 5},
});
