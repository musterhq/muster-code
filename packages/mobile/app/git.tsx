import {Stack, useFocusEffect, useLocalSearchParams, useRouter} from 'expo-router';
import {useCallback, useState} from 'react';
import {useComputerConnection} from '../src/connection/ConnectionProvider';
import {SourceControlScreen} from '../src/screens/SourceControlScreen';

/** Source control for the chat's folder; it reloads when a sheet over it closes (a branch switch changes everything). */
export default function Git() {
  const {chat, computer} = useLocalSearchParams<{chat: string; computer?: string}>();
  const {connection, view} = useComputerConnection(computer || undefined);
  const router = useRouter();
  const [visit, setVisit] = useState(0);
  useFocusEffect(useCallback(() => { setVisit(value => value + 1); }, []));
  if (!connection || !view || !chat) return null;
  return <>
    <Stack.Screen options={{title: 'Source control', headerBackTitle: 'Chat'}} />
    <SourceControlScreen key={visit} connection={connection} chatId={chat}
      onSwitchBranch={() => router.push({pathname: '/branch', params: {chat, computer: view.id}})}
      onOpenPullRequest={() => router.push({pathname: '/pull-request', params: {chat, computer: view.id}})} />
  </>;
}
