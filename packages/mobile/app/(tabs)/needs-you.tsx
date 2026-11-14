import {useRouter} from 'expo-router';
import {useLink} from '../../src/connection/ConnectionProvider';
import {NeedsYouScreen} from '../../src/screens/NeedsYouScreen';

export default function NeedsYou() {
  const {state} = useLink();
  const router = useRouter();
  if (state.phase !== 'connected') return null;
  return <NeedsYouScreen connection={state.connection} onOpen={id => router.push({pathname: '/chat/[id]', params: {id}})} />;
}
