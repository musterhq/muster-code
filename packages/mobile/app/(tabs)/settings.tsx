import {useRouter} from 'expo-router';
import {useLink} from '../../src/connection/ConnectionProvider';
import {SettingsScreen} from '../../src/screens/SettingsScreen';

export default function Settings() {
  const link = useLink();
  const router = useRouter();
  if (link.phase === 'loading') return null;
  return <SettingsScreen computers={link.computers} onPair={() => router.push('/pair')} onUnpair={id => void link.unpair(id).then(() => { if (link.computers.length <= 1) router.replace('/pair'); })} />;
}
