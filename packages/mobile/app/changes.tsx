import {Stack, useLocalSearchParams, useRouter} from 'expo-router';
import {useComputerConnection} from '../src/connection/ConnectionProvider';
import {ChangesScreen} from '../src/screens/ChangesScreen';

/** The chat's changed files; a file opens its diff. */
export default function Changes() {
  const {chat, computer} = useLocalSearchParams<{chat: string; computer?: string}>();
  const {connection, view} = useComputerConnection(computer || undefined);
  const router = useRouter();
  if (!connection || !view || !chat) return null;
  return <>
    <Stack.Screen options={{title: 'Changes'}} />
    <ChangesScreen connection={connection} chatId={chat} onOpenFile={path => router.push({pathname: '/diff', params: {chat, computer: view.id, path}})} />
  </>;
}
