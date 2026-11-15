import {Stack, useLocalSearchParams, useRouter} from 'expo-router';
import {useComputerConnection} from '../src/connection/ConnectionProvider';
import {FilesScreen} from '../src/screens/FilesScreen';

/** One folder of the chat's folder; a folder pushes another of these, a file opens the viewer. */
export default function Files() {
  const {chat, computer, path} = useLocalSearchParams<{chat: string; computer?: string; path?: string}>();
  const {connection, view} = useComputerConnection(computer || undefined);
  const router = useRouter();
  if (!connection || !view || !chat) return null;
  return <>
    <Stack.Screen options={{title: ''}} />
    <FilesScreen connection={connection} chatId={chat} path={path ?? ''}
      onOpenFolder={next => router.push({pathname: '/files', params: {chat, computer: view.id, path: next}})}
      onOpenFile={file => router.push({pathname: '/file', params: {chat, computer: view.id, path: file}})} />
  </>;
}
