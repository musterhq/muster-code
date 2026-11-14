import {Redirect, Stack, useRouter} from 'expo-router';
import {StyleSheet, Text, View} from 'react-native';
import {useLink} from '../src/connection/ConnectionProvider';
import {ChatsScreen} from '../src/screens/ChatsScreen';
import {Button} from '../src/components/Button';
import {colors, space} from '../src/theme';

export default function Index() {
  const {state, retry} = useLink();
  const router = useRouter();
  if (state.phase === 'loading') return <View style={styles.center} />;
  if (state.phase === 'unpaired') return <Redirect href="/pair" />;
  const actions = <View style={styles.actions}>{state.phase === 'connected' ? <Text style={styles.link} onPress={() => router.push('/new-chat')}>New chat</Text> : null}<Text style={styles.link} onPress={() => router.push('/needs-you')}>Needs you</Text><Text style={styles.link} onPress={() => router.push('/settings')}>Settings</Text></View>;
  if (state.phase !== 'connected') return (
    <View style={styles.center}>
      <Stack.Screen options={{headerRight: () => actions}} />
      <Text style={styles.text}>{state.phase === 'revoked' ? `This phone is no longer paired with ${state.record.desktopName}.` : `Connecting to ${state.record.desktopName}…`}</Text>
      {state.phase === 'connecting' && state.error ? <Text style={styles.muted}>{state.error}</Text> : null}
      {state.phase === 'revoked' ? <Button label="Pair again" kind="primary" onPress={() => router.push('/pair')} /> : <Button label="Try now" onPress={retry} />}
    </View>
  );
  return (
    <>
      <Stack.Screen options={{title: state.connection.desktopName, headerRight: () => actions}} />
      <ChatsScreen connection={state.connection} onOpen={id => router.push({pathname: '/chat/[id]', params: {id}})} />
    </>
  );
}
const styles = StyleSheet.create({
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.m, padding: space.l, backgroundColor: colors.background},
  text: {color: colors.text, textAlign: 'center'},
  muted: {color: colors.muted, textAlign: 'center'},
  actions: {flexDirection: 'row', gap: space.l},
  link: {color: colors.accent},
});
