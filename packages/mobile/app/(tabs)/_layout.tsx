/** The four tabs of the v3 design (Chats, Needs you with its count, Projects, Settings) in the glass tab bar, with search as
 *  its own circle: it opens Chats with its search field. Each tab draws its own large title, so the tabs have no header. */
import {router, Tabs} from 'expo-router';
import {useLink} from '../../src/connection/ConnectionProvider';
import {useNeedsCount} from '../../src/hooks';
import {GlassTabBar, type TabName} from '../../src/components/GlassTabBar';
import {useTheme} from '../../src/theme';

export default function TabsLayout() {
  const c = useTheme();
  const {selected} = useLink();
  const needs = useNeedsCount(selected?.connection ?? null);
  return (
    <Tabs
      tabBar={({state, navigateToTab}) => (
        <GlassTabBar active={state.routes[state.index]!.name as TabName} needs={needs}
          onTab={name => { const route = state.routes.find(entry => entry.name === name); if (route) navigateToTab(route.key); }}
          onSearch={() => router.navigate({pathname: '/', params: {search: String(Date.now())}})} />
      )}
      screenOptions={{headerShown: false, sceneStyle: {backgroundColor: c.background}, animation: 'fade'}}>
      <Tabs.Screen name="index" options={{title: 'Chats'}} />
      <Tabs.Screen name="needs-you" options={{title: 'Needs you'}} />
      <Tabs.Screen name="projects" options={{title: 'Projects'}} />
      <Tabs.Screen name="settings" options={{title: 'Settings'}} />
    </Tabs>
  );
}
