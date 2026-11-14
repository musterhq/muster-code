import {Redirect, Tabs, useRouter} from 'expo-router';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useLink} from '../../src/connection/ConnectionProvider';
import {ChatsScreen} from '../../src/screens/ChatsScreen';
import {Button} from '../../src/components/Button';
import {space, themed, touch, type} from '../../src/theme';

export default function Index() {
  const {state, retry} = useLink();
  const router = useRouter();
  const styles = useStyles();
  if (state.phase === 'loading') return <View style={styles.center} />;
  if (state.phase === 'unpaired') return <Redirect href="/pair" />;
  const add = state.phase === 'connected' ? () => (
    <Pressable accessibilityRole="button" accessibilityLabel="New chat" hitSlop={8} onPress={() => router.push('/new-chat')} style={styles.add}><Text style={styles.addLabel}>＋</Text></Pressable>
  ) : undefined;
  if (state.phase !== 'connected') return (
    <View style={styles.center}>
      <Tabs.Screen options={{title: 'Chats', headerRight: add}} />
      <Text style={styles.text}>{state.phase === 'revoked' ? `This phone is no longer paired with ${state.record.desktopName}.` : `Connecting to ${state.record.desktopName}…`}</Text>
      {state.phase === 'connecting' && state.error ? <Text style={styles.muted}>{state.error}</Text> : null}
      {state.phase === 'revoked' ? <Button label="Pair again" kind="primary" onPress={() => router.push('/pair')} /> : <Button label="Try now" onPress={retry} />}
    </View>
  );
  return (
    <>
      <Tabs.Screen options={{title: 'Chats', headerRight: add}} />
      <ChatsScreen connection={state.connection} onOpen={id => router.push({pathname: '/chat/[id]', params: {id}})} />
    </>
  );
}
const useStyles = themed(c => StyleSheet.create({
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.m, padding: space.l, backgroundColor: c.background},
  text: {color: c.text, ...type.body, textAlign: 'center'},
  muted: {color: c.muted, ...type.footnote, textAlign: 'center'},
  add: {width: touch, height: touch, alignItems: 'center', justifyContent: 'center', marginRight: space.s},
  addLabel: {color: c.strong, fontSize: 20},
}));
