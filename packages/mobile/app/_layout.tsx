import {Stack} from 'expo-router';
import {StatusBar} from 'expo-status-bar';
import {ConnectionProvider} from '../src/connection/ConnectionProvider';
import {colors} from '../src/theme';

export default function Layout() {
  return (
    <ConnectionProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{headerStyle: {backgroundColor: colors.surface}, headerTintColor: colors.text, contentStyle: {backgroundColor: colors.background}}}>
        <Stack.Screen name="index" options={{title: 'Chats'}} />
        <Stack.Screen name="pair" options={{title: 'Pair'}} />
        <Stack.Screen name="chat/[id]" options={{title: ''}} />
        <Stack.Screen name="needs-you" options={{title: 'Needs you'}} />
        <Stack.Screen name="settings" options={{title: 'Settings'}} />
      </Stack>
    </ConnectionProvider>
  );
}
