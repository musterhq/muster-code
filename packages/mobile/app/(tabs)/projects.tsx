import {StyleSheet, Text, View} from 'react-native';
import {space, themed, type} from '../../src/theme';

/** Projects (tasks, runs and Inbox) arrive in a later phase of #326; the tab is in place so the navigation does not move. */
export default function Projects() {
  const styles = useStyles();
  return (
    <View style={styles.center}>
      <Text style={styles.title}>Projects are coming</Text>
      <Text style={styles.body}>Tasks, runs and the Inbox from your computer will show here in a later update.</Text>
    </View>
  );
}
const useStyles = themed(c => StyleSheet.create({
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.s, backgroundColor: c.background},
  title: {color: c.strong, ...type.headline, fontWeight: '600'},
  body: {color: c.muted, ...type.footnote, textAlign: 'center'},
}));
