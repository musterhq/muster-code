/** Settings in the iOS anatomy (v3): this phone as the hero row, then its computers (an eye on a watch-only one; tap one for
 *  what it allows and Unpair), then Pair another computer. Unpairing asks first and forgets that computer's keys and
 *  everything cached from it on this phone. */
import {useState} from 'react';
import {Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {ComputerView} from '../connection/computers';
import {StatusDot} from '../components/ComputerPill';
import {computerStatus, WatchOnly} from '../components/ComputerSwitcher';
import {Icon} from '../components/Icon';
import {TAB_BAR_SPACE} from '../components/GlassTabBar';
import {haptics} from '../haptics';
import {radius, size, space, themed, type, useTheme} from '../theme';
import {LargeTitle} from './ChatsHome';

export function SettingsScreen({computers, onUnpair, onPair}: {computers: ComputerView[]; onUnpair(id: string): void; onPair(): void}) {
  const styles = useStyles(), c = useTheme();
  const [open, setOpen] = useState<string | null>(null);
  const unpair = (view: ComputerView) => {
    haptics.warning();
    Alert.alert(`Unpair ${view.name}?`, 'This phone forgets its keys and the chats it saved from it.', [{text: 'Cancel', style: 'cancel'}, {text: 'Unpair', style: 'destructive', onPress: () => onUnpair(view.id)}]);
  };
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <LargeTitle title="Settings" />
      <View style={styles.group}>
        <View style={[styles.row, styles.hero]}>
          <View style={[styles.tile, styles.heroTile]}><Icon name="phone" size={26} color={c.onAccent} stroke={1.9} /></View>
          <View style={styles.body}><Text style={styles.heroTitle}>This phone</Text><Text style={styles.sub}>{`${Platform.OS === 'ios' ? 'iPhone' : 'Android'} · ${computers.length === 1 ? '1 computer' : `${computers.length} computers`}`}</Text></View>
        </View>
      </View>
      <Text style={styles.section}>Computers</Text>
      <View style={styles.group}>
        {computers.map((view, index) => (
          <View key={view.id}>
            <Pressable accessibilityRole="button" accessibilityLabel={view.name} accessibilityHint={computerStatus(view)} onPress={() => { haptics.select(); setOpen(current => current === view.id ? null : view.id); }}
              style={({pressed}) => [styles.row, index > 0 && styles.divider, pressed && styles.pressed]}>
              <View style={styles.tile}><Icon name="laptop" size={20} color={c.text} stroke={1.8} /></View>
              <View style={styles.body}>
                <View style={styles.line}><Text style={styles.name} numberOfLines={1}>{view.name}</Text>{view.access === 'read-only' ? <WatchOnly /> : null}</View>
                <View style={styles.line}><StatusDot path={view.path} /><Text style={styles.sub} numberOfLines={1}>{computerStatus(view)}</Text></View>
              </View>
              <Icon name={open === view.id ? 'chevD' : 'chevR'} size={16} color={c.faint} stroke={2.4} />
            </Pressable>
            {open === view.id ? <View style={styles.detail}>
              <Text style={styles.sub}>{view.access === 'act' ? 'This phone can read, send, steer and answer here.' : view.access === 'read-only' ? 'Watch only: this phone can read. To send, steer and answer, choose Can act for it in Settings › Integrations › Phone on the computer.' : 'Connecting…'}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Unpair ${view.name}`} onPress={() => unpair(view)} style={styles.unpair}><Text style={styles.danger}>{`Unpair ${view.name}`}</Text></Pressable>
            </View> : null}
          </View>
        ))}
        <Pressable accessibilityRole="button" onPress={onPair} style={[styles.row, computers.length > 0 && styles.divider]}>
          <View style={[styles.tile, {backgroundColor: c.accentTint}]}><Icon name="plus" size={20} color={c.accent} stroke={2.2} /></View>
          <Text style={styles.action}>Pair another computer</Text>
        </Pressable>
      </View>
      <Text style={styles.footer}>Change what this phone can do on a computer, or revoke it, in Settings › Integrations › Phone on that computer.</Text>
    </ScrollView>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  content: {paddingBottom: TAB_BAR_SPACE},
  group: {marginHorizontal: space.card, backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  section: {color: c.muted, ...type.footnote, fontWeight: '500', paddingHorizontal: space.margin + 12, paddingTop: space.xl, paddingBottom: space.s},
  row: {flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52, paddingHorizontal: space.l, paddingVertical: 10},
  hero: {minHeight: 76},
  pressed: {backgroundColor: c.raised},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  tile: {width: 32, height: 32, borderRadius: 8, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center'},
  heroTile: {width: 52, height: 52, borderRadius: 14, backgroundColor: c.accentFill},
  body: {flex: 1, gap: 2},
  line: {flexDirection: 'row', alignItems: 'center', gap: space.s},
  heroTitle: {color: c.text, ...type.title3},
  name: {color: c.text, ...type.body, flexShrink: 1},
  sub: {color: c.muted, ...type.subhead, flexShrink: 1},
  detail: {paddingHorizontal: space.l, paddingLeft: space.l + 32 + 14, paddingBottom: space.m, gap: space.s},
  unpair: {minHeight: size.small, justifyContent: 'center'},
  danger: {color: c.danger, ...type.body},
  action: {color: c.accent, ...type.body},
  footer: {color: c.muted, ...type.footnote, paddingHorizontal: space.margin + 12, paddingTop: space.s},
}));
