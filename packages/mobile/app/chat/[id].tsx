import {Stack, useLocalSearchParams, useRouter} from 'expo-router';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useComputerConnection} from '../../src/connection/ConnectionProvider';
import {ChatScreen} from '../../src/screens/ChatScreen';
import {pickAttachment} from '../../src/connection/pickers';
import {Icon} from '../../src/components/Icon';
import {Glass} from '../../src/components/v3';
import {size, themed, type, useTheme} from '../../src/theme';

/** One header bar (v3): the chat's title with its folder or Project under it, and Changes as a glass button with its count. */
export default function Chat() {
  const {id, computer, draft} = useLocalSearchParams<{id: string; computer?: string; draft?: string}>();
  const {view, connection} = useComputerConnection(computer || undefined);
  const router = useRouter();
  const styles = useStyles(), c = useTheme();
  if (!connection || !view || !id) return null;
  const review = () => router.push({pathname: '/changes', params: {chat: id, computer: view.id}});
  const tools = () => router.push({pathname: '/tools', params: {chat: id, computer: view.id}});
  return <ChatScreen connection={connection} chatId={id} path={view.path} pickAttachment={pickAttachment} onReview={review} {...(draft ? {initialDraft: draft} : {})} header={(chat, changes) => (
    <Stack.Screen options={{
      headerTitle: () => (
        <View style={styles.title}>
          <Text style={styles.name} numberOfLines={1}>{chat?.title ?? ''}</Text>
          <Text style={styles.place} numberOfLines={1}>{[chat?.place, view.name].filter(Boolean).join(' · ')}</Text>
        </View>
      ),
      headerRight: () => (
        <View style={styles.right}>
          {changes ? <Glass radius={size.glassCircle / 2}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Changes, ${changes} ${changes === 1 ? 'file' : 'files'}`} onPress={review} style={styles.changes}>
              <Icon name="diff" size={20} color={c.text} /><Text style={styles.count}>{changes}</Text>
            </Pressable>
          </Glass> : null}
          <Glass radius={size.glassCircle / 2}>
            <Pressable accessibilityRole="button" accessibilityLabel="Files, Git and more" onPress={tools} style={styles.more}><Icon name="more" size={20} color={c.text} /></Pressable>
          </Glass>
        </View>
      ),
    }} />
  )} />;
}
const useStyles = themed(c => StyleSheet.create({
  title: {alignItems: 'center', maxWidth: 220},
  name: {color: c.text, ...type.headline},
  place: {color: c.muted, ...type.footnote},
  right: {flexDirection: 'row', gap: 8},
  more: {width: size.glassCircle, height: size.glassCircle, alignItems: 'center', justifyContent: 'center'},
  changes: {flexDirection: 'row', alignItems: 'center', gap: 6, height: size.glassCircle, paddingHorizontal: 14},
  count: {color: c.text, ...type.headline},
}));
