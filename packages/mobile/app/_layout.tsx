import {Stack} from 'expo-router';
import {StatusBar} from 'expo-status-bar';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {KeyboardProvider} from 'react-native-keyboard-controller';
import {ConnectionProvider} from '../src/connection/ConnectionProvider';
import {useTheme} from '../src/theme';

export default function Layout() {
  const c = useTheme();
  return (
    <GestureHandlerRootView style={{flex: 1}}>
      <KeyboardProvider>
        <ConnectionProvider>
          <StatusBar style={c.scheme === 'light' ? 'dark' : 'light'} />
          <Stack screenOptions={{headerStyle: {backgroundColor: c.background}, headerTintColor: c.strong, headerShadowVisible: false, contentStyle: {backgroundColor: c.background}, animation: 'default'}}>
            <Stack.Screen name="(tabs)" options={{headerShown: false}} />
            <Stack.Screen name="pair" options={{title: 'Pair with your computer'}} />
            <Stack.Screen name="chat/[id]" options={{title: ''}} />
            <Stack.Screen name="new-chat" options={{title: 'New chat', presentation: 'formSheet', sheetGrabberVisible: true}} />
          </Stack>
        </ConnectionProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
