import {useRouter} from 'expo-router';
import {useLink} from '../src/connection/ConnectionProvider';
import {SettingsScreen} from '../src/screens/SettingsScreen';

export default function Settings() {
  const {state, unpair} = useLink();
  const router = useRouter();
  if (state.phase === 'loading' || state.phase === 'unpaired') return null;
  const status = state.phase === 'connected' ? 'Connected' : state.phase === 'revoked' ? 'Revoked on the computer' : state.error ? `Not connected: ${state.error}` : 'Connecting…';
  return <SettingsScreen desktopName={state.record.desktopName} access={state.phase === 'connected' ? state.connection.access : null} status={status} onUnpair={() => void unpair().then(() => router.replace('/pair'))} />;
}
