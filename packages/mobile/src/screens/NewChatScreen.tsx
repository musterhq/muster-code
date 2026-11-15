/** New chat: pick a folder or Project from the computer's list, a provider and one of its models, then start the chat on the
 *  computer and open it. Needs act access; the computer checks again. */
import {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import type {MobileConnection, MobileMethods, MobilePlace} from '../shared';
import {errorText, READ_ONLY_NOTE, useAccess} from '../hooks';
import {Button} from '../components/Button';
import {font, radius, space, themed, useTheme} from '../theme';

type Options = MobileMethods['chat.options']['result'];

function Choice({label, detail, selected, onPress}: {label: string; detail?: string; selected: boolean; onPress(): void}) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{selected}} onPress={onPress} style={[styles.choice, selected && styles.selected]}>
      <Text style={styles.choiceLabel}>{label}</Text>
      {detail ? <Text style={styles.muted}>{detail}</Text> : null}
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
    setBusy(true); setError(null);
    try {
      const {chat} = await connection.call('chat.create', {...(place?.kind === 'folder' ? {folderId: place.id} : place?.kind === 'project' ? {projectId: place.id} : {}), providerId, model});
      onCreated(chat.id);
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {!options && !error ? <Text style={styles.muted}>Loading…</Text> : null}
      {options ? <>
        <Text style={styles.label}>Where</Text>
        {options.places.length ? options.places.map(entry => <Choice key={`${entry.kind}:${entry.id}`} label={entry.name} detail={entry.kind === 'project' ? 'Project' : 'Folder'} selected={place?.kind === entry.kind && place.id === entry.id} onPress={() => setPlace(entry)} />)
          : <Text style={styles.muted}>No folders or Projects on {connection.desktopName}; the chat starts without one.</Text>}
        <Text style={styles.label}>Provider</Text>
        {options.providers.length ? options.providers.map(entry => <Choice key={entry.id} label={entry.name} selected={entry.id === providerId} onPress={() => { setProviderId(entry.id); setModel(entry.models[0]?.id ?? null); }} />)
          : <Text style={styles.muted}>No provider is ready on {connection.desktopName}. Connect one in Muster on your computer.</Text>}
        {provider ? <>
          <Text style={styles.label}>Model</Text>
          {provider.models.map(entry => <Choice key={entry.id} label={entry.name} detail={entry.images ? undefined : 'Text only'} selected={entry.id === model} onPress={() => setModel(entry.id)} />)}
        </> : null}
        <Button label={busy ? 'Starting…' : 'Start chat'} kind="primary" disabled={busy || !providerId || !model} onPress={() => void start()} />
      </> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}
const useStyles = themed(colors => StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  content: {padding: space.l, gap: space.s},
  label: {color: colors.muted, fontSize: font.small, marginTop: space.m},
  choice: {borderWidth: 1, borderColor: colors.border, borderRadius: radius.m, paddingVertical: space.s, paddingHorizontal: space.m, gap: 2},
  selected: {borderColor: colors.accent, backgroundColor: colors.surface},
  choiceLabel: {color: colors.text, fontSize: font.body},
  muted: {color: colors.muted, fontSize: font.small},
  note: {color: colors.muted, fontSize: font.small, padding: space.l},
  error: {color: colors.danger, fontSize: font.small},
}));
