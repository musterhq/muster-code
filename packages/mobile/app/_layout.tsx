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
          <Stack screenOptions={{headerStyle: {backgroundColor: c.background}, headerTintColor: c.text, headerTitleStyle: {fontSize: 17, fontWeight: '600'}, headerShadowVisible: false, contentStyle: {backgroundColor: c.background}, animation: 'default'}}>
            <Stack.Screen name="(tabs)" options={{headerShown: false}} />
            <Stack.Screen name="pair" options={{title: 'Pair with your computer'}} />
            <Stack.Screen name="chat/[id]" options={{title: ''}} />
            <Stack.Screen name="new-chat" options={{title: 'New chat', presentation: 'formSheet', sheetGrabberVisible: true, sheetAllowedDetents: [0.6, 1], sheetCornerRadius: 38}} />
            <Stack.Screen name="changes" options={{title: 'Changes'}} />
            <Stack.Screen name="diff" options={{title: ''}} />
            <Stack.Screen name="tools" options={{title: '', presentation: 'formSheet', sheetGrabberVisible: true, sheetAllowedDetents: [0.45], sheetCornerRadius: 38}} />
            <Stack.Screen name="files" options={{title: ''}} />
            <Stack.Screen name="file" options={{title: ''}} />
            <Stack.Screen name="git" options={{title: 'Source control'}} />
            <Stack.Screen name="branch" options={{title: 'Switch branch', presentation: 'formSheet', sheetGrabberVisible: true, sheetAllowedDetents: [0.6, 1], sheetCornerRadius: 38}} />
            <Stack.Screen name="pull-request" options={{title: 'Pull request', presentation: 'formSheet', sheetGrabberVisible: true, sheetAllowedDetents: [1], sheetCornerRadius: 38}} />
          </Stack>
        </ConnectionProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
