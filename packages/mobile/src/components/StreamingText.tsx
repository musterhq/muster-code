/** A reply's text as it streams. Code fences read in monospace; the rest is plain selectable text. Kept on its own so a
 *  Markdown renderer can replace it without touching the list or the rows. */
import {memo} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {font, space, themed, type} from '../theme';

/** Splits ``` fences out so code reads in monospace. */
export function textParts(text: string): Array<{code: boolean; text: string}> {
  return text.split(/```[^\n]*\n?/).map((part, index) => ({code: index % 2 === 1, text: part.replace(/\n$/, '')})).filter(part => part.text.length > 0);
}

export const StreamingText = memo(function StreamingText({text}: {text: string}) {
  const styles = useStyles();
  const parts = textParts(text);
  if (parts.length <= 1 && !parts[0]?.code) return <Text style={styles.text} selectable>{text}</Text>;
  return (
    <View style={styles.parts}>
      {parts.map((part, index) => <Text key={index} selectable style={part.code ? styles.code : styles.text}>{part.text}</Text>)}
    </View>
  );
});
const useStyles = themed(c => StyleSheet.create({
  parts: {gap: space.s},
  text: {color: c.text, ...type.body},
  code: {color: c.text, fontFamily: font.mono, ...type.label, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, padding: space.s, borderRadius: 8},
}));
