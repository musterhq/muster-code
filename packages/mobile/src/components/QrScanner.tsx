/** The camera QR scanner for pairing (expo-camera). Only the first muster:// code scanned is reported. */
import {useRef} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {CameraView, useCameraPermissions} from 'expo-camera';
import {Button} from './Button';
import {space, themed, useTheme} from '../theme';

export function QrScanner({onScan}: {onScan(text: string): void}) {
  const styles = useStyles(), colors = useTheme();
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);
  if (!permission) return null;
  if (!permission.granted) return (
    <View style={styles.ask}>
      <Text style={styles.muted}>Muster needs the camera to scan the pairing code.</Text>
      <Button label="Allow camera" kind="primary" onPress={() => void request()} />
    </View>
  );
  return <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{barcodeTypes: ['qr']}}
    onBarcodeScanned={({data}) => { if (!done.current && data.startsWith('muster://pair?')) { done.current = true; onScan(data); } }} />;
}
const useStyles = themed(colors => StyleSheet.create({
  ask: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.m, padding: space.l},
  muted: {color: colors.text, textAlign: 'center'},
}));
