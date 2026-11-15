/** The v3 tab bar: one glass capsule with the four tabs (the selected one on a lighter pill, Needs you with its count), and
 *  search as its own glass circle beside it. It floats over the content with a scroll-edge fade below the lists. */
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {haptics} from '../haptics';
import {size, space, themed, useTheme} from '../theme';
import {Icon, type IconName} from './Icon';
import {EdgeFade, Glass} from './v3';

export type TabName = 'index' | 'needs-you' | 'projects' | 'settings';
const TABS: Array<[TabName, string, IconName]> = [['index', 'Chats', 'chats'], ['needs-you', 'Needs you', 'needs'], ['projects', 'Projects', 'projects'], ['settings', 'Settings', 'gear']];
/** Room lists leave at their end so the last row clears the floating bar. */
export const TAB_BAR_SPACE = size.tabBar + 40;

export function GlassTabBar({active, needs, onTab, onSearch}: {active: TabName; needs: number; onTab(name: TabName): void; onSearch(): void}) {
  const styles = useStyles(), c = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <EdgeFade edge="bottom" height={120 + insets.bottom} />
      <View style={[styles.row, {marginBottom: Math.max(insets.bottom, space.l)}]} pointerEvents="box-none">
        <Glass radius={size.tabBar / 2} style={styles.bar}>
          <View style={styles.tabs} accessibilityRole="tablist">
            {TABS.map(([name, label, icon]) => {
              const on = name === active, count = name === 'needs-you' ? needs : 0;
              return (
                <Pressable key={name} accessibilityRole="tab" accessibilityLabel={count ? `${label}, ${count} waiting` : label} accessibilityState={{selected: on}}
                  onPress={() => { if (!on) { haptics.select(); onTab(name); } }} style={[styles.tab, on && styles.tabOn]}>
                  <Icon name={icon} size={24} color={on ? c.accent : c.text} stroke={on ? 2.1 : 1.8} />
                  <Text style={[styles.label, {color: on ? c.accent : c.text}]} numberOfLines={1}>{label}</Text>
                  {count ? <View style={styles.badge}><Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text></View> : null}
                </Pressable>
              );
            })}
          </View>
        </Glass>
        <Glass radius={size.tabBar / 2} style={styles.search}>
          <Pressable accessibilityRole="button" accessibilityLabel="Search" onPress={() => { haptics.select(); onSearch(); }} style={styles.searchHit}>
            <Icon name="search" size={24} color={c.text} />
          </Pressable>
        </Glass>
      </View>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  wrap: {position: 'absolute', left: 0, right: 0, bottom: 0},
  row: {flexDirection: 'row', gap: 10, marginHorizontal: space.margin, zIndex: 6},
  bar: {flex: 1, height: size.tabBar},
  tabs: {flex: 1, flexDirection: 'row', padding: 4},
  tab: {flex: 1, borderRadius: 27, alignItems: 'center', justifyContent: 'center', gap: 2},
  tabOn: {backgroundColor: c.glassSelected},
  label: {fontSize: 12, lineHeight: 14, fontWeight: '600'},
  badge: {position: 'absolute', top: 3, left: '56%', minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: c.badge, alignItems: 'center', justifyContent: 'center'},
  badgeText: {color: '#ffffff', fontSize: 12, lineHeight: 14, fontWeight: '700'},
  search: {width: size.tabBar, height: size.tabBar},
  searchHit: {flex: 1, alignItems: 'center', justifyContent: 'center'},
}));
