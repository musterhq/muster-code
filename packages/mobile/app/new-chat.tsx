import {useRouter} from 'expo-router';
import {useLink} from '../src/connection/ConnectionProvider';
import {NewChatScreen} from '../src/screens/NewChatScreen';

export default function NewChat() {
  const {state} = useLink();
  const router = useRouter();
  if (state.phase !== 'connected') return null;
  return <NewChatScreen connection={state.connection} onCreated={id => router.replace({pathname: '/chat/[id]', params: {id}})} />;
}
