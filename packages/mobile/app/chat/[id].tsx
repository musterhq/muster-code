import {Stack, useLocalSearchParams} from 'expo-router';
import {Text, View} from 'react-native';
import {useComputerConnection} from '../../src/connection/ConnectionProvider';
import {ChatScreen} from '../../src/screens/ChatScreen';
import {pickAttachment} from '../../src/connection/pickers';
import {themed, type} from '../../src/theme';

/** One header bar: the stack's own, with the chat's title and its folder or Project and computer under it. */
export default function Chat() {
  const {id, computer} = useLocalSearchParams<{id: string; computer?: string}>();
  const {view, connection} = useComputerConnection(computer || undefined);
  const styles = useStyles();
  if (!connection || !view || !id) return null;
  return <ChatScreen connection={connection} chatId={id} path={view.path} pickAttachment={pickAttachment} header={chat => (
    <Stack.Screen options={{headerTitle: () => (
      <View style={styles.title}>
        <Text style={styles.name} numberOfLines={1}>{chat?.title ?? ''}</Text>
        <Text style={styles.place} numberOfLines={1}>{[chat?.place, view.name].filter(Boolean).join(' · ')}</Text>
      </View>
    )}} />
  )} />;
}
const useStyles = themed(c => ({
  title: {alignItems: 'center' as const, maxWidth: 240},
  name: {color: c.strong, ...type.footnote, fontWeight: '600' as const},
  place: {color: c.faint, ...type.caption},
}));
