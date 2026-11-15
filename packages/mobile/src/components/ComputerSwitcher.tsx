/** The computer switcher sheet (#326 phase 4): each paired computer with how it is connected and what this phone may do
 *  there, Pair another computer, and Show all computers together. A pick gives a selection haptic and closes the sheet. */
import {Modal, Pressable, StyleSheet, Switch, Text, View} from 'react-native';
import type {ComputerView} from '../connection/computers';
import {haptics} from '../haptics';
import {ago} from '../time';
import {space, themed, touch, type, useTheme} from '../theme';
import {StatusDot} from './ComputerPill';

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

export function ComputerSwitcher({visible, computers, selectedId, showAll, onSelect, onShowAll, onPair, onClose}: {visible: boolean; computers: ComputerView[]; selectedId: string | null; showAll: boolean; onSelect(id: string): void; onShowAll(on: boolean): void; onPair(): void; onClose(): void}) {
  const styles = useStyles(), c = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close computers" />
      <View style={styles.sheet} testID="computer-switcher">
        <View style={styles.grabber} />
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">Computers</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={10} style={styles.close}><Text style={styles.closeText}>✕</Text></Pressable>
        </View>
        <View style={styles.group}>
          {computers.map((view, index) => (
            <Pressable key={view.id} accessibilityRole="button" accessibilityLabel={view.name} accessibilityHint={computerStatus(view)} accessibilityState={{selected: view.id === selectedId}}
              onPress={() => { haptics.select(); onSelect(view.id); onClose(); }} style={({pressed}) => [styles.row, index > 0 && styles.divider, (pressed || view.id === selectedId) && styles.rowOn]}>
              <View style={styles.icon}><Text style={styles.iconText}>▭</Text><View style={styles.iconDot}><StatusDot path={view.path} size={8} /></View></View>
              <View style={styles.body}>
                <View style={styles.line}>
                  <Text style={styles.name} numberOfLines={1}>{view.name}</Text>
                  {view.access ? <Text style={[styles.chip, view.access === 'act' && styles.chipAct]}>{view.access === 'act' ? 'Can act' : 'Read only'}</Text> : null}
                </View>
                <Text style={[styles.status, view.path === 'revoked' && {color: c.danger}]} numberOfLines={2}>{computerStatus(view)}</Text>
              </View>
              {view.id === selectedId && !showAll ? <Text style={styles.check}>✓</Text> : null}
            </Pressable>
          ))}
        </View>
        <View style={styles.group}>
          <Pressable accessibilityRole="button" onPress={() => { onClose(); onPair(); }} style={styles.row}>
            <Text style={styles.action}>Pair another computer</Text>
          </Pressable>
          <View style={[styles.row, styles.divider]}>
            <Text style={styles.label}>Show all computers together</Text>
            <Switch accessibilityLabel="Show all computers together" value={showAll} onValueChange={on => { haptics.select(); onShowAll(on); }} trackColor={{true: c.accentFill, false: c.raised}} />
          </View>
        </View>
        <Text style={styles.note}>Each computer has its own encrypted link and its own access level.</Text>
      </View>
    </Modal>
  );
}
const useStyles = themed(c => StyleSheet.create({
  scrim: {flex: 1, backgroundColor: 'rgba(0,0,0,0.45)'},
  sheet: {backgroundColor: c.menu, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: space.l, paddingBottom: space.xl + space.l, gap: space.m},
  grabber: {alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: c.control, marginTop: space.s},
  head: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: touch},
  title: {color: c.strong, ...type.headline, fontWeight: '600'},
  close: {position: 'absolute', right: 0, width: 30, height: 30, borderRadius: 15, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center'},
  closeText: {color: c.muted, ...type.label},
  group: {backgroundColor: c.surface, borderRadius: 14, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: touch + 8, paddingHorizontal: space.m, paddingVertical: space.s},
  rowOn: {backgroundColor: c.raised},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  icon: {width: 36, height: 36, borderRadius: 9, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center'},
  iconText: {color: c.muted, fontSize: 18},
  iconDot: {position: 'absolute', right: -2, bottom: -2, padding: 2, borderRadius: 6, backgroundColor: c.surface},
  body: {flex: 1, gap: 2},
  line: {flexDirection: 'row', alignItems: 'center', gap: space.s},
  name: {color: c.strong, ...type.footnote, fontWeight: '600', flexShrink: 1},
  chip: {color: c.muted, backgroundColor: c.raised, ...type.micro, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, overflow: 'hidden'},
  chipAct: {color: c.accent},
  status: {color: c.faint, ...type.caption},
  check: {color: c.accent, ...type.headline},
  action: {color: c.accent, ...type.footnote, fontWeight: '500'},
  label: {flex: 1, color: c.text, ...type.footnote},
  note: {color: c.faint, ...type.caption, paddingHorizontal: space.xs},
}));
