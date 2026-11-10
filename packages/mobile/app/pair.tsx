import {useRouter} from 'expo-router';
import {useLink} from '../src/connection/ConnectionProvider';
import {PairScreen} from '../src/screens/PairScreen';
import {QrScanner} from '../src/components/QrScanner';

export default function Pair() {
  const {pair, store, retry} = useLink();
  const router = useRouter();
  return <PairScreen pairWith={pair} store={store} scanner={onScan => <QrScanner onScan={onScan} />} onPaired={() => { retry(); router.replace('/'); }} />;
}
