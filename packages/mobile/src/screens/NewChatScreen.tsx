/** New chat: pick a folder or Project from the computer's list, a provider and one of its models, then start the chat on the
 *  computer and open it. Needs act access; the computer checks again. */
import {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import type {MobileConnection, MobileMethods, MobilePlace} from '../shared';
import {errorText, READ_ONLY_NOTE, requestId, useAccess} from '../hooks';
import {haptics} from '../haptics';
import {Icon} from '../components/Icon';
import {Button} from '../components/Button';
import {radius, space, themed, type, useTheme} from '../theme';

type Options = MobileMethods['chat.options']['result'];

/** One row of a grouped list with a check on the chosen one. */
function Choice({label, detail, selected, onPress, first}: {label: string; detail?: string; selected: boolean; onPress(): void; first: boolean}) {
  const styles = useStyles(), c = useTheme();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{selected}} accessibilityLabel={label} onPress={() => { haptics.select(); onPress(); }} style={({pressed}) => [styles.choice, !first && styles.divider, pressed && styles.pressed]}>
      <View style={styles.choiceBody}>
        <Text style={styles.choiceLabel}>{label}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {selected ? <Icon name="check" size={20} color={c.accent} stroke={2.4} /> : null}
    </Pressable>
  );
}

export function NewChatScreen({connection, onCreated}: {connection: MobileConnection; onCreated(chatId: string): void}) {
  const styles = useStyles(), colors = useTheme();
  const access = useAccess(connection);
  const [options, setOptions] = useState<Options | null>(null);
  const [place, setPlace] = useState<MobilePlace | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (access !== 'act') return;
    let live = true;
    connection.call('chat.options', {}).then(result => {
      if (!live) return;
      setOptions(result);
      setPlace(current => current ?? result.places[0] ?? null);
      const first = result.providers[0];
      setProviderId(current => current ?? first?.id ?? null);
      setModel(current => current ?? first?.models[0]?.id ?? null);
    }, failure => { if (live) setError(errorText(failure)); });
    return () => { live = false; };
  }, [connection, access]);
  if (access !== 'act') return <View style={styles.screen}><Text style={styles.note}>{READ_ONLY_NOTE}</Text></View>;
  const provider = options?.providers.find(entry => entry.id === providerId) ?? null;
  const start = async () => {
    if (!providerId || !model || busy) return;
    haptics.medium();
    setBusy(true); setError(null);
    try {
      const {chat} = await connection.call('chat.create', {...(place?.kind === 'folder' ? {folderId: place.id} : place?.kind === 'project' ? {projectId: place.id} : {}), providerId, model});
      // The task goes as the chat's first message.
      if (task.trim()) await connection.call('chat.send', {id: chat.id, text: task.trim(), requestId: requestId()});
      onCreated(chat.id);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <TextInput style={styles.task} placeholder="What should the agent do?" placeholderTextColor={colors.muted} value={task} onChangeText={setTask} multiline autoFocus={false} />
        {!options && !error ? <Text style={styles.muted}>Loading…</Text> : null}
        {options ? <>
          <Text style={styles.label}>Where</Text>
          {options.places.length ? <View style={styles.group}>{options.places.map((entry, index) => <Choice key={`${entry.kind}:${entry.id}`} first={index === 0} label={entry.name} detail={entry.kind === 'project' ? 'Project' : 'Folder'} selected={place?.kind === entry.kind && place.id === entry.id} onPress={() => setPlace(entry)} />)}</View>
            : <Text style={styles.muted}>No folders or Projects on {connection.desktopName}; the chat starts without one.</Text>}
          <Text style={styles.label}>Agent</Text>
          {options.providers.length ? <View style={styles.group}>{options.providers.map((entry, index) => <Choice key={entry.id} first={index === 0} label={entry.name} selected={entry.id === providerId} onPress={() => { setProviderId(entry.id); setModel(entry.models[0]?.id ?? null); }} />)}</View>
            : <Text style={styles.muted}>No provider is ready on {connection.desktopName}. Connect one in Muster on your computer.</Text>}
          {provider ? <>
            <Text style={styles.label}>Model</Text>
            <View style={styles.group}>{provider.models.map((entry, index) => <Choice key={entry.id} first={index === 0} label={entry.name} detail={entry.images ? undefined : 'Text only'} selected={entry.id === model} onPress={() => setModel(entry.id)} />)}</View>
          </> : null}
        </> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
      {options ? <View style={styles.bottom}><Button label={busy ? 'Starting…' : 'Start chat'} kind="primary" busy={busy} disabled={!providerId || !model} onPress={() => void start()} /></View> : null}
    </View>
  );
}
const useStyles = themed(colors => StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  content: {padding: space.card, gap: space.s, paddingBottom: space.xl},
  task: {minHeight: 96, backgroundColor: colors.surface, borderRadius: radius.card, padding: space.l, color: colors.text, ...type.body, textAlignVertical: 'top'},
  label: {color: colors.muted, ...type.footnote, fontWeight: '500', paddingHorizontal: space.l, marginTop: space.l},
  group: {backgroundColor: colors.surface, borderRadius: radius.group, overflow: 'hidden'},
  choice: {flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 52, paddingHorizontal: space.l, paddingVertical: 10},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border},
  pressed: {backgroundColor: colors.raised},
  choiceBody: {flex: 1, gap: 2},
  choiceLabel: {color: colors.text, ...type.body},
  detail: {color: colors.muted, ...type.subhead},
  muted: {color: colors.muted, ...type.subhead, paddingHorizontal: space.l},
  note: {color: colors.muted, ...type.subhead, padding: space.margin},
  error: {color: colors.danger, ...type.footnote, paddingHorizontal: space.l},
  bottom: {padding: space.card, paddingBottom: space.xl},
}));
