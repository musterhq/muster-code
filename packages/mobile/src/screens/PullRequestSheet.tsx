/** Open a pull request (v3, MUS-SPEC-23-25K): base and head read as a sentence, the title and a Markdown description, Draft and
 *  reviewers. It opens on the computer with the computer's own GitHub sign-in, pushing the branch first when it has to; the
 *  phone never holds a token. */
import {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';
import type {MobileConnection, MobilePullRequestDraft} from '../shared';
import {errorText} from '../hooks';
import {haptics} from '../haptics';
import {Button} from '../components/Button';
import {font, radius, space, themed, type, useTheme} from '../theme';

export function PullRequestSheet({connection, chatId, onOpened}: {connection: MobileConnection; chatId: string; onOpened(url: string): void}) {
  const styles = useStyles(), c = useTheme();
  const [draft, setDraft] = useState<MobilePullRequestDraft | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [isDraft, setIsDraft] = useState(false);
  const [reviewers, setReviewers] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    connection.call('pr.draft', {chatId}).then(next => { setDraft(next); setTitle(next.title); setBody(next.body); }, failure => setError(errorText(failure)));
  }, [connection, chatId]);
  const open = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const names = reviewers.split(/[\s,]+/).map(name => name.replace(/^@/, '')).filter(Boolean);
      const pr = await connection.call('pr.create', {chatId, base: draft.base, title: title.trim(), body, draft: isDraft, ...(names.length ? {reviewers: names} : {})});
      haptics.success();
      onOpened(pr.url);
    } catch (failure) { setError(errorText(failure)); haptics.warning(); } finally { setBusy(false); }
  };
  if (!draft) return <View style={styles.sheet}><Text style={error ? styles.error : styles.muted}>{error ?? 'Loading…'}</Text></View>;
  if (!draft.available) return <View style={styles.sheet}><Text style={styles.muted}>{draft.reason ?? `Pull requests can’t be opened for this folder from ${connection.desktopName}.`}</Text></View>;
  return (
    <ScrollView style={styles.sheet} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.sentence}>{`${draft.head} into ${draft.base}`}</Text>
      {draft.existing ? <Text style={styles.muted}>{`#${draft.existing.number} is already open for this branch: ${draft.existing.title}`}</Text> : null}
      <Text style={styles.section}>Title</Text>
      <TextInput accessibilityLabel="Title" value={title} onChangeText={setTitle} style={styles.field} placeholderTextColor={c.faint} />
      <Text style={styles.section}>Description</Text>
      <TextInput accessibilityLabel="Description" value={body} onChangeText={setBody} multiline style={[styles.field, styles.body]} placeholder="Markdown" placeholderTextColor={c.faint} />
      <View style={styles.group}>
        <View style={styles.row}>
          <Text style={styles.label}>Draft</Text>
          <Switch accessibilityRole="switch" accessibilityLabel="Draft" value={isDraft} onValueChange={value => { setIsDraft(value); haptics.select(); }} trackColor={{true: c.accent, false: c.fill}} />
        </View>
        <View style={[styles.row, styles.divider]}>
          <Text style={styles.label}>Reviewers</Text>
          <TextInput accessibilityLabel="Reviewers" value={reviewers} onChangeText={setReviewers} placeholder="names, comma separated" placeholderTextColor={c.faint} autoCapitalize="none" autoCorrect={false} style={styles.inline} />
        </View>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.action}><Button label="Open pull request" kind="primary" grow busy={busy} disabled={!title.trim()} onPress={() => void open()} /></View>
      <Text style={styles.foot}>{draft.needsPush ? `Pushes first, then opens it from ${connection.desktopName}` : `Opens it from ${connection.desktopName}`}</Text>
    </ScrollView>
  );
}
const useStyles = themed(c => StyleSheet.create({
  sheet: {flex: 1, backgroundColor: c.raised},
  content: {paddingTop: space.l, paddingBottom: 40},
  sentence: {color: c.text, ...type.subhead, fontFamily: font.mono, textAlign: 'center', paddingHorizontal: space.margin},
  section: {color: c.muted, ...type.footnote, fontWeight: '600', paddingHorizontal: space.margin, paddingTop: space.l, paddingBottom: space.s},
  field: {marginHorizontal: space.card, paddingHorizontal: space.l, paddingVertical: space.m, borderRadius: radius.well, backgroundColor: c.surface, color: c.text, ...type.body},
  body: {minHeight: 140, textAlignVertical: 'top', ...type.subhead},
  group: {marginHorizontal: space.card, marginTop: space.l, backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 52, paddingHorizontal: space.l},
  divider: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border},
  label: {flex: 1, color: c.text, ...type.body},
  inline: {flex: 2, color: c.muted, ...type.body, textAlign: 'right', paddingVertical: 0},
  error: {color: c.danger, ...type.footnote, paddingHorizontal: space.margin, paddingTop: space.s},
  muted: {color: c.muted, ...type.footnote, padding: space.margin},
  action: {flexDirection: 'row', marginHorizontal: space.card, marginTop: space.xl},
  foot: {color: c.muted, ...type.footnote, textAlign: 'center', paddingTop: space.s},
}));
