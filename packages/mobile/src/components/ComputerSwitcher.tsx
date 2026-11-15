/** The computer switcher sheet (v3): each paired computer on two plain lines (how it is connected, and how to reach it), an eye
 *  on a watch-only one instead of an access pill, Pair another computer, and Show all computers together. A pick gives a
 *  selection haptic and closes the sheet. */
import {Modal, Pressable, StyleSheet, Switch, Text, View} from 'react-native';
import type {ComputerView} from '../connection/computers';
import {haptics} from '../haptics';
import {ago} from '../time';
import {radius, size, space, themed, touch, type, useTheme} from '../theme';
import {StatusDot} from './ComputerPill';
import {Icon} from './Icon';

export function computerStatus(view: ComputerView, now = Date.now()): string {
  switch (view.path) {
    case 'lan': return 'Connected · LAN direct';
    case 'relay': return 'Connected · Relay';
    case 'connecting': return 'Connecting…';
    case 'reconnecting': return 'Reconnecting… · sends wait in the outbox';
    case 'offline': return `Offline${view.downSince ? ` · last seen ${ago(new Date(view.downSince).toISOString(), now)} ago` : ''} · shows cached chats`;
    case 'revoked': return 'This phone was removed on the computer';
  }
}

/** The eye a watch-only computer carries. */
export function WatchOnly() {
  const c = useTheme();
  return <View accessible accessibilityLabel="Watch only"><Icon name="eye" size={18} color={c.muted} stroke={1.9} /></View>;
}

export function ComputerSwitcher({visible, computers, selectedId, showAll, onSelect, onShowAll, onPair, onClose}: {visible: boolean; computers: ComputerView[]; selectedId: string | null; showAll: boolean; onSelect(id: string): void; onShowAll(on: boolean): void; onPair(): void; onClose(): void}) {
  const styles = useStyles(), c = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close computers" />
      <View style={styles.sheet} testID="computer-switcher">
        <View style={styles.grabber} />
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">Computers</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={10} style={styles.close}><Icon name="x" size={18} color={c.muted} stroke={2.4} /></Pressable>
        </View>
        <View style={styles.group}>
          {computers.map((view, index) => (
            <Pressable key={view.id} accessibilityRole="button" accessibilityLabel={view.name} accessibilityHint={computerStatus(view)} accessibilityState={{selected: view.id === selectedId}}
              onPress={() => { haptics.select(); onSelect(view.id); onClose(); }} style={({pressed}) => [styles.row, index > 0 && styles.divider, pressed && styles.rowOn]}>
              <View style={styles.icon}><Icon name="laptop" size={22} color={c.text} stroke={1.8} /><View style={styles.iconDot}><StatusDot path={view.path} size={9} /></View></View>
              <View style={styles.body}>
                <View style={styles.line}>
                  <Text style={styles.name} numberOfLines={1}>{view.name}</Text>
                  {view.access === 'read-only' ? <WatchOnly /> : null}
                </View>
                <Text style={[styles.status, view.path === 'revoked' && {color: c.danger}]} numberOfLines={2}>{computerStatus(view)}</Text>
              </View>
              {view.id === selectedId && !showAll ? <Icon name="check" size={20} color={c.accent} stroke={2.4} /> : null}
            </Pressable>
          ))}
        </View>
        <View style={styles.group}>
          <Pressable accessibilityRole="button" onPress={() => { onClose(); onPair(); }} style={styles.row}>
            <Icon name="plus" size={20} color={c.accent} stroke={2.2} /><Text style={styles.action}>Pair another computer</Text>
          </Pressable>
          <View style={[styles.row, styles.divider]}>
            <Text style={styles.label}>Show all computers together</Text>
            <Switch accessibilityLabel="Show all computers together" value={showAll} onValueChange={on => { haptics.select(); onShowAll(on); }} trackColor={{true: c.success, false: c.fill}} />
          </View>
        </View>
        <Text style={styles.note}>Each computer has its own encrypted link and its own access.</Text>
      </View>
    </Modal>
  );
}
const useStyles = themed(c => StyleSheet.create({
  scrim: {flex: 1, backgroundColor: c.scrim},
  sheet: {backgroundColor: c.menu, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingHorizontal: space.card, paddingBottom: 40, gap: space.l},
  grabber: {alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: c.fill, marginTop: space.s},
  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: touch},
  title: {color: c.text, ...type.headline},
  close: {position: 'absolute', right: 0, width: 32, height: 32, borderRadius: 16, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center'},
  group: {backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 66, paddingHorizontal: space.l, paddingVertical: 11},
  rowOn: {backgroundColor: c.raised},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  icon: {width: size.glyph, height: size.glyph, borderRadius: 10, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center'},
  iconDot: {position: 'absolute', right: -3, bottom: -3, padding: 2, borderRadius: 7, backgroundColor: c.surface},
  body: {flex: 1, gap: 2},
  line: {flexDirection: 'row', alignItems: 'center', gap: space.s},
  name: {color: c.text, ...type.body, fontWeight: '500', flexShrink: 1},
  status: {color: c.muted, ...type.subhead},
  action: {color: c.accent, ...type.body},
  label: {flex: 1, color: c.text, ...type.body},
  note: {color: c.muted, ...type.footnote, paddingHorizontal: space.xs},
}));
