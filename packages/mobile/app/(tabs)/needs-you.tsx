import {useRouter} from 'expo-router';
import {useLink} from '../../src/connection/ConnectionProvider';
import {NeedsYouScreen} from '../../src/screens/NeedsYouScreen';

/** Needs you for the chosen computer, or for every computer when they are shown together. */
export default function NeedsYou() {
  const link = useLink();
  const router = useRouter();
  const views = (link.showAll ? link.computers : link.selected ? [link.selected] : []).filter(view => view.connection);
  if (!views.length) return null;
  return <NeedsYouScreen sources={views.map(view => ({id: view.id, name: view.name, connection: view.connection!}))} onOpen={(id, computer) => router.push({pathname: '/chat/[id]', params: {id, computer}})} />;
}
