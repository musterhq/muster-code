import {Stack, useLocalSearchParams} from 'expo-router';
import {Text, View} from 'react-native';
import {useLink} from '../../src/connection/ConnectionProvider';
import {ChatScreen} from '../../src/screens/ChatScreen';
import {pickAttachment} from '../../src/connection/pickers';
import {themed, type} from '../../src/theme';

/** One header bar: the stack's own, with the chat's title and its folder or Project under it. */
export default function Chat() {
  const {id} = useLocalSearchParams<{id: string}>();
  const {state} = useLink();
  const styles = useStyles();
  if (state.phase !== 'connected' || !id) return null;
  return <ChatScreen connection={state.connection} chatId={id} pickAttachment={pickAttachment} header={chat => (
    <Stack.Screen options={{headerTitle: () => (
      <View style={styles.title}>
        <Text style={styles.name} numberOfLines={1}>{chat?.title ?? ''}</Text>
        {chat?.place ? <Text style={styles.place} numberOfLines={1}>{chat.place}</Text> : null}
      </View>
    )}} />
  )} />;
}
const useStyles = themed(c => ({
  title: {alignItems: 'center' as const, maxWidth: 240},
  name: {color: c.strong, ...type.footnote, fontWeight: '600' as const},
  place: {color: c.faint, ...type.caption},
}));
