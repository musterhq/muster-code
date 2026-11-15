import {Stack, useLocalSearchParams} from 'expo-router';
import {useComputerConnection} from '../src/connection/ConnectionProvider';
import {DiffScreen} from '../src/screens/DiffScreen';
import {fileName, folderOf} from '../src/screens/ChangesScreen';

/** One changed file's diff: its name as the title and its folder under it. */
export default function Diff() {
  const {chat, computer, path} = useLocalSearchParams<{chat: string; computer?: string; path: string}>();
  const {connection} = useComputerConnection(computer || undefined);
  if (!connection || !chat || !path) return null;
  return <>
    <Stack.Screen options={{title: fileName(path), headerBackTitle: 'Changes', ...(folderOf(path) ? {headerTitle: `${fileName(path)}`} : {})}} />
    <DiffScreen connection={connection} chatId={chat} path={path} />
  </>;
}
