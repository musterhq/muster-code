/** The Chats tab (v3): the large title with the computer line under it (it opens the computer switcher) and New chat in a
 *  glass capsule, over the chat list of the chosen computer, or of every computer when Show all computers together is on. */
import {useState, type ReactElement} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {ComputerView} from '../connection/computers';
import {ComputerPill} from '../components/ComputerPill';
import {ComputerSwitcher} from '../components/ComputerSwitcher';
import {Button} from '../components/Button';
import {Icon} from '../components/Icon';
import {EdgeFade, Glass} from '../components/v3';
import {size, space, themed, type, useTheme} from '../theme';
import {ChatsScreen, type ChatSource} from './ChatsScreen';
import {EmptyArt} from './Moments';

export interface ComputersProps {
  computers: ComputerView[]; selectedId: string | null; showAll: boolean;
  onSelect(id: string): void; onShowAll(on: boolean): void; onPair(): void;
}
const sourceOf = (view: ComputerView): ChatSource | null => view.connection ? {id: view.id, name: view.name, connection: view.connection, path: view.path} : null;

/** The computer line for the chosen computer (or "All computers"), with its switcher; for any screen's large title. */
export function ComputerHeader({computers, selectedId, showAll, onSelect, onShowAll, onPair}: ComputersProps) {
  const [open, setOpen] = useState(false);
  const selected = computers.find(view => view.id === selectedId) ?? computers[0];
  if (!selected) return null;
  const allPath = computers.some(view => view.path === 'lan' || view.path === 'relay') ? 'relay' : 'offline';
  return (
    <>
      {showAll && computers.length > 1
        ? <ComputerPill name="All computers" path={allPath} label={`${computers.length}`} onPress={() => setOpen(true)} />
        : <ComputerPill name={selected.name} path={selected.path} onPress={() => setOpen(true)} />}
      <ComputerSwitcher visible={open} computers={computers} selectedId={selected.id} showAll={showAll} onSelect={id => { onSelect(id); onShowAll(false); }} onShowAll={onShowAll} onPair={onPair} onClose={() => setOpen(false)} />
    </>
  );
}

/** A large title (34 pt) with an optional second line and glass buttons at the top right. */
export function LargeTitle({title, children, actions}: {title: string; children?: ReactElement | null; actions?: Array<{icon: 'compose' | 'more' | 'search'; label: string; onPress(): void}>}) {
  const styles = useStyles(), c = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.top, {paddingTop: insets.top + space.s}]}>
      <View style={styles.bar}>
        {actions?.length ? <Glass radius={size.glassCircle / 2} style={styles.capsule}>
          {actions.map(action => <Pressable key={action.label} accessibilityRole="button" accessibilityLabel={action.label} hitSlop={4} onPress={action.onPress} style={styles.action}><Icon name={action.icon} size={21} color={c.text} /></Pressable>)}
        </Glass> : null}
      </View>
      <Text style={styles.title} accessibilityRole="header">{title}</Text>
      {children ? <View style={styles.sub}>{children}</View> : null}
    </View>
  );
}

export function ChatsHome(props: ComputersProps & {onOpen(chatId: string, computerId: string): void; onNew?(): void; searching?: boolean}) {
  const styles = useStyles();
  const {computers, selectedId, showAll, onPair, onOpen, onNew, searching} = props;
  const selected = computers.find(view => view.id === selectedId) ?? computers[0];
  const sources = (showAll ? computers : selected ? [selected] : []).map(sourceOf).filter((source): source is ChatSource => source !== null);
  const header = <LargeTitle title="Chats" actions={onNew ? [{icon: 'compose', label: 'New chat', onPress: onNew}] : []}><ComputerHeader {...props} /></LargeTitle>;
  return (
    <View style={styles.screen}>
      {sources.length ? <ChatsScreen sources={sources} onOpen={onOpen} header={header} searching={Boolean(searching)}
        empty={<View style={styles.center}>
          <EmptyArt />
          <Text style={styles.emptyTitle}>Start your first chat</Text>
          <Text style={styles.text}>{`It runs on ${selected?.name ?? 'your computer'}. Chats you start on the computer appear here live.`}</Text>
          {onNew ? <Button label="New chat" kind="primary" onPress={onNew} /> : null}
        </View>} /> : (
        <View style={styles.screen}>
          {header}
          <View style={styles.center}>
            <Text style={styles.text}>{selected?.path === 'revoked' ? `This phone is no longer paired with ${selected.name}.` : 'No computer to show yet.'}</Text>
            <Button label={selected?.path === 'revoked' ? 'Pair again' : 'Pair a computer'} kind="primary" onPress={onPair} />
          </View>
        </View>
      )}
      <EdgeFade edge="top" height={60} />
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  top: {paddingHorizontal: space.margin, paddingBottom: space.s},
  bar: {minHeight: size.glassCircle, flexDirection: 'row', justifyContent: 'flex-end'},
  capsule: {flexDirection: 'row', height: size.glassCircle, paddingHorizontal: 4},
  action: {width: 40, height: size.glassCircle, alignItems: 'center', justifyContent: 'center'},
  title: {color: c.text, ...type.largeTitle, letterSpacing: 0.37},
  sub: {marginTop: 2},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.m, padding: space.xl, paddingTop: 48},
  emptyTitle: {color: c.text, ...type.title2, marginTop: space.l},
  text: {color: c.muted, ...type.body, lineHeight: 24, textAlign: 'center'},
}));
