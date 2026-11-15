/** A provider question, answered in place. One single-choice question answers on tap; otherwise pick, then Send answers. */
import {useState} from 'react';
import {Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import type {MobileConnection, MobileQuestion} from '../shared';
import {errorText, READ_ONLY_NOTE} from '../hooks';
import {radius, size, space, themed, type, useTheme} from '../theme';
import {haptics} from '../haptics';
import {Icon} from './Icon';
import {Button} from './Button';

export function QuestionCard({connection, itemId, questions, status, canAct, note = READ_ONLY_NOTE}: {connection: MobileConnection; itemId: string; questions: MobileQuestion[]; status?: string; canAct: boolean; /** Why it can't be answered here. */ note?: string}) {
  const styles = useStyles(), colors = useTheme();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const pending = !status || status === 'pending';
  const instant = questions.length === 1 && !questions[0]!.multiSelect;
  const send = (answers: Record<string, string[]>) => { setError(null); connection.call('question.respond', {itemId, answers}).then(() => haptics.success(), failure => setError(errorText(failure))); };
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
      {questions.map((question, index) => (
        <View key={question.id} style={styles.question}>
          <View style={styles.head}>
            <View style={styles.tile}><Icon name="chats" size={20} color={colors.accent} stroke={2.1} /></View>
            <View style={styles.headText}>
              <Text style={styles.title}>{question.question}</Text>
              <View style={styles.metaRow}>
                {question.header ? <Text style={styles.meta}>{question.header}</Text> : null}
                {questions.length > 1 ? <View style={styles.dots} accessibilityLabel={`Question ${index + 1} of ${questions.length}`}>{questions.map((_, dot) => <View key={dot} style={[styles.dot, dot === index && styles.dotOn]} />)}</View> : null}
              </View>
            </View>
          </View>
          {question.secret ? <Text style={styles.muted}>Answer this one on your computer: it asks for a secret.</Text>
            : pending && canAct ? (
              <>
                <View style={styles.options}>
                  {question.options.map(option => {
                    const on = Boolean(picked[question.id]?.includes(option.label));
                    return (
                      <Pressable key={option.label} accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'} accessibilityLabel={option.label} accessibilityState={{checked: on}}
                        onPress={() => { haptics.select(); choose(question, option.label); }} style={({pressed}) => [styles.option, pressed && styles.pressed]}>
                        <View style={styles.optionText}>
                          <Text style={styles.optionLabel}>{option.label}</Text>
                          {option.description ? <Text style={styles.optionWhy}>{option.description}</Text> : null}
                        </View>
                        <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
                      </Pressable>
                    );
                  })}
                </View>
                {question.allowCustomAnswer && !instant ? <TextInput style={styles.input} placeholder="Your own answer" placeholderTextColor={colors.muted} value={custom[question.id] ?? ''} onChangeText={text => setCustom(current => ({...current, [question.id]: text}))} /> : null}
              </>
            ) : null}
        </View>
      ))}
      {!pending ? <Text style={styles.muted}>{status === 'answered' ? 'Answered' : status}</Text> : !canAct ? <Text style={styles.muted}>{note}</Text> : null}
      {pending && canAct && !instant ? <Button label="Send answers" kind="primary" disabled={!ready} onPress={() => send(Object.fromEntries(questions.map(question => [question.id, custom[question.id]?.trim() ? [custom[question.id]!.trim()] : picked[question.id] ?? []])))} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
const useStyles = themed(colors => StyleSheet.create({
  card: {backgroundColor: colors.surface, borderRadius: radius.card, padding: space.l, gap: space.l},
  question: {gap: 14},
  head: {flexDirection: 'row', gap: space.m, alignItems: 'flex-start'},
  tile: {width: size.glyph, height: size.glyph, borderRadius: size.glyph / 2, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center'},
  headText: {flex: 1, gap: 2},
  title: {color: colors.text, ...type.headline},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: space.s},
  meta: {color: colors.muted, ...type.footnote},
  dots: {flexDirection: 'row', gap: 4},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: colors.fill},
  dotOn: {backgroundColor: colors.accent},
  options: {gap: space.s},
  option: {flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 50, borderRadius: radius.capsule, backgroundColor: colors.fill, paddingHorizontal: 18, paddingVertical: 10},
  pressed: {opacity: 0.7},
  optionText: {flex: 1, gap: 2},
  optionLabel: {color: colors.text, ...type.body, fontWeight: '500'},
  optionWhy: {color: colors.muted, ...type.footnote},
  radio: {width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.control, alignItems: 'center', justifyContent: 'center'},
  radioOn: {borderColor: colors.accent},
  radioDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent},
  muted: {color: colors.muted, ...type.subhead},
  error: {color: colors.danger, ...type.footnote},
  input: {borderWidth: 1, borderColor: colors.control, borderRadius: radius.well, color: colors.text, paddingHorizontal: space.l, height: 46, ...type.body},
}));
