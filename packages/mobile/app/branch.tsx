import {useLocalSearchParams, useRouter} from 'expo-router';
import {useComputerConnection} from '../src/connection/ConnectionProvider';
import {BranchSheet} from '../src/screens/BranchSheet';

export default function Branch() {
  const {chat, computer} = useLocalSearchParams<{chat: string; computer?: string}>();
  const {connection} = useComputerConnection(computer || undefined);
  const router = useRouter();
  if (!connection || !chat) return null;
  return <BranchSheet connection={connection} chatId={chat} onDone={() => router.back()} />;
}
