/** The four tabs of the approved design: Chats, Needs you (with a live badge), Projects and Settings. */
import {Tabs} from 'expo-router';
import {StyleSheet, Text, View} from 'react-native';
import {useLink} from '../../src/connection/ConnectionProvider';
import {useNeedsCount} from '../../src/hooks';
import {themed, type, useTheme} from '../../src/theme';

function TabMark({focused, badge}: {focused: boolean; badge?: number}) {
  const styles = useStyles();
  return (
    <View style={[styles.mark, focused && styles.markOn]}>
      {badge ? <Text style={styles.badge} accessibilityLabel={`${badge} waiting`}>{badge > 99 ? '99+' : badge}</Text> : null}
    </View>
  );
}

export default function TabsLayout() {
  const c = useTheme();
  const {state} = useLink();
  const needs = useNeedsCount(state.phase === 'connected' ? state.connection : null);
  return (
    <Tabs screenOptions={{
      headerStyle: {backgroundColor: c.background}, headerTintColor: c.strong, headerShadowVisible: false, headerTitleStyle: {...type.headline, fontWeight: '700'},
      tabBarStyle: {backgroundColor: c.scheme === 'light' ? c.surface : '#121212', borderTopColor: c.border},
      tabBarActiveTintColor: c.accent, tabBarInactiveTintColor: c.faint, tabBarLabelStyle: type.micro,
      sceneStyle: {backgroundColor: c.background}, animation: 'fade',
    }}>
      <Tabs.Screen name="index" options={{title: 'Chats', tabBarIcon: ({focused}) => <TabMark focused={focused} />}} />
      <Tabs.Screen name="needs-you" options={{title: 'Needs you', tabBarIcon: ({focused}) => <TabMark focused={focused} badge={needs} />}} />
      <Tabs.Screen name="projects" options={{title: 'Projects', tabBarIcon: ({focused}) => <TabMark focused={focused} />}} />
      <Tabs.Screen name="settings" options={{title: 'Settings', tabBarIcon: ({focused}) => <TabMark focused={focused} />}} />
    </Tabs>
  );
}
const useStyles = themed(c => StyleSheet.create({
  mark: {width: 18, height: 18, borderRadius: 5, backgroundColor: c.scheme === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)'},
  markOn: {backgroundColor: c.scheme === 'light' ? 'rgba(59,106,147,0.3)' : 'rgba(145,171,194,0.3)'},
  badge: {position: 'absolute', top: -5, right: -10, minWidth: 16, paddingHorizontal: 4, borderRadius: 8, overflow: 'hidden', backgroundColor: c.danger, color: '#ffffff', fontSize: 10, lineHeight: 14, fontWeight: '700', textAlign: 'center'},
}));
