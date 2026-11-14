/** The Chats tab (#326 phase 4): the computer pill over the chat list of the chosen computer, or of every computer when
 *  Show all computers together is on; the pill opens the computer switcher. */
import {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {ComputerView} from '../connection/computers';
import {ComputerPill} from '../components/ComputerPill';
import {ComputerSwitcher} from '../components/ComputerSwitcher';
import {Button} from '../components/Button';
import {space, themed, type} from '../theme';
import {ChatsScreen, type ChatSource} from './ChatsScreen';

export interface ComputersProps {
  computers: ComputerView[]; selectedId: string | null; showAll: boolean;
  onSelect(id: string): void; onShowAll(on: boolean): void; onPair(): void;
}
const sourceOf = (view: ComputerView): ChatSource | null => view.connection ? {id: view.id, name: view.name, connection: view.connection, path: view.path} : null;

/** The pill for the chosen computer (or "All computers"), with its switcher; for any screen's header. */
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

export function ChatsHome(props: ComputersProps & {onOpen(chatId: string, computerId: string): void}) {
  const styles = useStyles();
  const {computers, selectedId, showAll, onPair, onOpen} = props;
  const selected = computers.find(view => view.id === selectedId) ?? computers[0];
  const sources = (showAll ? computers : selected ? [selected] : []).map(sourceOf).filter((source): source is ChatSource => source !== null);
  return (
    <View style={styles.screen}>
      <View style={styles.header}><ComputerHeader {...props} /></View>
      {sources.length ? <ChatsScreen sources={sources} onOpen={onOpen} /> : (
        <View style={styles.center}>
          <Text style={styles.text}>{selected?.path === 'revoked' ? `This phone is no longer paired with ${selected.name}.` : 'No computer to show yet.'}</Text>
          <Button label={selected?.path === 'revoked' ? 'Pair again' : 'Pair a computer'} kind="primary" onPress={onPair} />
        </View>
      )}
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  header: {paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.s},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.m, padding: space.l},
  text: {color: c.text, ...type.body, textAlign: 'center'},
}));
