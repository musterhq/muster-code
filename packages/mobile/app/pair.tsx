import {useLocalSearchParams, useRouter} from 'expo-router';
import {useLink} from '../src/connection/ConnectionProvider';
import {PairScreen} from '../src/screens/PairScreen';
import {QrScanner} from '../src/components/QrScanner';
import {pairingLinkFromParams} from '../src/deep-link';

/** Also the target of muster://pair?… deep links (the app's scheme in app.json): expo-router hands the query here, and the
 *  screen fills it in and pairs at once. */
export default function Pair() {
  const {pair, store, retry} = useLink();
  const router = useRouter();
  const initialLink = pairingLinkFromParams(useLocalSearchParams());
  return <PairScreen pairWith={pair} store={store} initialLink={initialLink} scanner={onScan => <QrScanner onScan={onScan} />} onPaired={() => { retry(); router.replace('/'); }} />;
}
