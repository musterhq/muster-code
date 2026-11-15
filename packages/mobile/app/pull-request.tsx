import {useLocalSearchParams, useRouter} from 'expo-router';
import {Linking} from 'react-native';
import {useComputerConnection} from '../src/connection/ConnectionProvider';
import {PullRequestSheet} from '../src/screens/PullRequestSheet';

export default function PullRequest() {
  const {chat, computer} = useLocalSearchParams<{chat: string; computer?: string}>();
  const {connection} = useComputerConnection(computer || undefined);
  const router = useRouter();
  if (!connection || !chat) return null;
  return <PullRequestSheet connection={connection} chatId={chat} onOpened={url => { router.back(); void Linking.openURL(url); }} />;
}
