import {Redirect, useLocalSearchParams, useRouter} from 'expo-router';
import {useWindowDimensions, View} from 'react-native';
import {useLink} from '../../src/connection/ConnectionProvider';
import {TabletShell} from '../../src/screens/TabletShell';
import {useTheme} from '../../src/theme';

export default function Index() {
  const link = useLink();
  const router = useRouter();
  const c = useTheme();
  const {width} = useWindowDimensions();
  // The tab bar's search circle opens Chats with its search field.
  const {search} = useLocalSearchParams<{search?: string}>();
  if (link.phase === 'loading') return <View style={{flex: 1, backgroundColor: c.background}} />;
  if (!link.computers.length) return <Redirect href="/pair" />;
  const live = link.selected && (link.selected.path === 'lan' || link.selected.path === 'relay');
  return (
    <TabletShell width={width} computers={link.computers} selectedId={link.selected?.id ?? null} showAll={link.showAll} onSelect={link.select} onShowAll={link.setShowAll}
      searching={Boolean(search)} {...(live ? {onNew: () => router.push('/new-chat')} : {})}
      onPair={() => router.push('/pair')} onOpen={(id, computer) => router.push({pathname: '/chat/[id]', params: {id, computer}})} />
  );
}
