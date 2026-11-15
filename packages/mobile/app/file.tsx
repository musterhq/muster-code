import {Stack, useLocalSearchParams, useRouter} from 'expo-router';
import {StyleSheet, Text, View} from 'react-native';
import {useComputerConnection} from '../src/connection/ConnectionProvider';
import {FileViewer} from '../src/screens/FileViewer';
import {fileName, folderOf} from '../src/screens/ChangesScreen';
import {themed, type} from '../src/theme';

/** A file of the chat's folder: its name as the title and its folder under it. Ask about this goes back to the chat with the
 *  file named in the composer. */
export default function File() {
  const {chat, computer, path} = useLocalSearchParams<{chat: string; computer?: string; path: string}>();
  const {connection, view} = useComputerConnection(computer || undefined);
  const router = useRouter();
  const styles = useStyles();
  if (!connection || !view || !chat || !path) return null;
  return <>
    <Stack.Screen options={{headerTitle: () => (
      <View style={styles.title}>
        <Text style={styles.name} numberOfLines={1}>{fileName(path)}</Text>
        {folderOf(path) ? <Text style={styles.folder} numberOfLines={1}>{folderOf(path)}</Text> : null}
      </View>
    )}} />
    <FileViewer connection={connection} chatId={chat} path={path}
      onShowDiff={file => router.push({pathname: '/diff', params: {chat, computer: view.id, path: file}})}
      onAsk={file => router.dismissTo({pathname: '/chat/[id]', params: {id: chat, computer: view.id, draft: `About \`${file}\`: `}})} />
  </>;
}
const useStyles = themed(c => StyleSheet.create({
  title: {alignItems: 'center', maxWidth: 220},
  name: {color: c.text, ...type.headline},
  folder: {color: c.muted, ...type.footnote},
}));
