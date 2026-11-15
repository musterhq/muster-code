import {StyleSheet, Text, View} from 'react-native';
import {LargeTitle} from '../../src/screens/ChatsHome';
import {EmptyArt} from '../../src/screens/Moments';
import {space, themed, type} from '../../src/theme';

/** Projects (tasks, runs and the Inbox) arrive in a later phase of #326; the tab is in place so the navigation does not move. */
export default function Projects() {
  const styles = useStyles();
  return (
    <View style={styles.screen}>
      <LargeTitle title="Projects" />
      <View style={styles.center}>
        <EmptyArt />
        <Text style={styles.title}>Projects are coming</Text>
        <Text style={styles.body}>Tasks, runs and the Inbox from your computer will show here in a later update.</Text>
      </View>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  screen: {flex: 1, backgroundColor: c.background},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.s, paddingBottom: 120},
  title: {color: c.text, ...type.title2, marginTop: space.l},
  body: {color: c.muted, ...type.body, lineHeight: 24, textAlign: 'center'},
}));
