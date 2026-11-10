import {useLocalSearchParams} from 'expo-router';
import {useLink} from '../../src/connection/ConnectionProvider';
import {ChatScreen} from '../../src/screens/ChatScreen';

export default function Chat() {
  const {id} = useLocalSearchParams<{id: string}>();
  const {state} = useLink();
  if (state.phase !== 'connected' || !id) return null;
  return <ChatScreen connection={state.connection} chatId={id} />;
}
