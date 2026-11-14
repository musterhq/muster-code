import {useRouter} from 'expo-router';
import {useLink} from '../src/connection/ConnectionProvider';
import {NewChatScreen} from '../src/screens/NewChatScreen';

export default function NewChat() {
  const {selected} = useLink();
  const router = useRouter();
  if (!selected?.connection || (selected.path !== 'lan' && selected.path !== 'relay')) return null;
  return <NewChatScreen connection={selected.connection} onCreated={id => router.replace({pathname: '/chat/[id]', params: {id, computer: selected.id}})} />;
}
