/** A provider question, answered in place. One single-choice question answers on tap; otherwise pick, then Send answers. */
import {useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import type {MobileConnection, MobileQuestion} from '../shared';
import {errorText, READ_ONLY_NOTE} from '../hooks';
import {colors, font, radius, space} from '../theme';
import {Button} from './Button';

export function QuestionCard({connection, itemId, questions, status, canAct}: {connection: MobileConnection; itemId: string; questions: MobileQuestion[]; status?: string; canAct: boolean}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const pending = !status || status === 'pending';
  const instant = questions.length === 1 && !questions[0]!.multiSelect;
  const send = (answers: Record<string, string[]>) => { setError(null); connection.call('question.respond', {itemId, answers}).catch(failure => setError(errorText(failure))); };
  const choose = (question: MobileQuestion, label: string) => {
    if (instant) return send({[question.id]: [label]});
    setPicked(current => {
      const now = current[question.id] ?? [];
      const next = question.multiSelect ? (now.includes(label) ? now.filter(entry => entry !== label) : [...now, label]) : [label];
      return {...current, [question.id]: next};
    });
  };
  const ready = questions.every(question => (picked[question.id]?.length ?? 0) > 0 || Boolean(custom[question.id]?.trim()));
  return (
    <View style={styles.card}>
      {questions.map(question => (
        <View key={question.id} style={styles.question}>
          {question.header ? <Text style={styles.header}>{question.header}</Text> : null}
          <Text style={styles.body}>{question.question}</Text>
          {question.secret ? <Text style={styles.muted}>Answer this one on your computer: it asks for a secret.</Text>
            : pending && canAct ? (
              <>
                <View style={styles.options}>
                  {question.options.map(option => <Button key={option.label} label={option.label} kind={picked[question.id]?.includes(option.label) ? 'primary' : 'secondary'} onPress={() => choose(question, option.label)} />)}
                </View>
                {question.allowCustomAnswer && !instant ? <TextInput style={styles.input} placeholder="Other answer" placeholderTextColor={colors.muted} value={custom[question.id] ?? ''} onChangeText={text => setCustom(current => ({...current, [question.id]: text}))} /> : null}
              </>
            ) : null}
        </View>
      ))}
      {!pending ? <Text style={styles.muted}>{status === 'answered' ? 'Answered' : status}</Text> : !canAct ? <Text style={styles.muted}>{READ_ONLY_NOTE}</Text> : null}
      {pending && canAct && !instant ? <Button label="Send answers" kind="primary" disabled={!ready} onPress={() => send(Object.fromEntries(questions.map(question => [question.id, custom[question.id]?.trim() ? [custom[question.id]!.trim()] : picked[question.id] ?? []])))} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {backgroundColor: colors.surface, borderRadius: radius.m, borderWidth: 1, borderColor: colors.accent, padding: space.m, gap: space.m},
  question: {gap: space.s},
  header: {color: colors.muted, fontSize: font.small, textTransform: 'uppercase'},
  body: {color: colors.text, fontSize: font.body},
  muted: {color: colors.muted, fontSize: font.small},
  error: {color: colors.danger, fontSize: font.small},
  options: {flexDirection: 'row', flexWrap: 'wrap', gap: space.s},
  input: {borderWidth: 1, borderColor: colors.border, borderRadius: radius.s, color: colors.text, padding: space.s},
});
