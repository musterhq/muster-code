import {Redirect, Tabs, useRouter} from 'expo-router';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useLink} from '../../src/connection/ConnectionProvider';
import {ChatsHome} from '../../src/screens/ChatsHome';
import {space, themed, touch} from '../../src/theme';

export default function Index() {
  const link = useLink();
  const router = useRouter();
  const styles = useStyles();
  if (link.phase === 'loading') return <View style={styles.center} />;
  if (!link.computers.length) return <Redirect href="/pair" />;
  const live = link.selected && (link.selected.path === 'lan' || link.selected.path === 'relay');
  const add = live ? () => (
    <Pressable accessibilityRole="button" accessibilityLabel="New chat" hitSlop={8} onPress={() => router.push('/new-chat')} style={styles.add}><Text style={styles.addLabel}>＋</Text></Pressable>
  ) : undefined;
  return (
    <>
      <Tabs.Screen options={{title: 'Chats', headerRight: add}} />
      <ChatsHome computers={link.computers} selectedId={link.selected?.id ?? null} showAll={link.showAll} onSelect={link.select} onShowAll={link.setShowAll}
        onPair={() => router.push('/pair')} onOpen={(id, computer) => router.push({pathname: '/chat/[id]', params: {id, computer}})} />
    </>
  );
}
const useStyles = themed(c => StyleSheet.create({
  center: {flex: 1, backgroundColor: c.background},
  add: {width: touch, height: touch, alignItems: 'center', justifyContent: 'center', marginRight: space.s},
  addLabel: {color: c.strong, fontSize: 20},
}));
