/** A reply as native Markdown (#326 phase 4). Prose goes to react-native-enriched-markdown (GitHub flavour: tables, task
 *  lists, maths); code blocks are native with line numbers and Copy; Mermaid and chart fences are cards with their height
 *  reserved, opening full screen. Each block is memoised, so a streaming reply re-renders only its last block. */
import {memo, useMemo, useRef, useState} from 'react';
import {Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {EnrichedMarkdownText} from 'react-native-enriched-markdown';
import * as Clipboard from 'expo-clipboard';
import {splitBlocks, sameBlock, type Block} from '../markdown/blocks';
import {haptics} from '../haptics';
import {reportRender} from '../perf';
import {font, space, themed, touch, type, useTheme, type Palette} from '../theme';

/** Cards keep this height before anything renders, so text below never jumps. */
export const CARD_HEIGHT = 180;
const CARD_TITLE = {diagram: 'Diagram', chart: 'Chart'} as const;
type Card = Extract<Block, {kind: 'card'}>;

const markdownStyle = (c: Palette) => ({
  paragraph: {color: c.text, fontSize: type.body.fontSize, lineHeight: type.body.lineHeight},
  h1: {color: c.strong, fontSize: 22}, h2: {color: c.strong, fontSize: 19}, h3: {color: c.strong, fontSize: 17},
  link: {color: c.accent}, code: {color: c.text, backgroundColor: c.raised, fontFamily: font.mono},
  blockquote: {color: c.muted, borderColor: c.control},
});

function CodeBlock({lang, code}: {lang: string; code: string}) {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copy = () => {
    void Clipboard.setStringAsync(code); haptics.tap(); setCopied(true);
    clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1200);
  };
  const lines = code.split('\n');
  return (
    <View style={styles.code}>
      <View style={styles.codeHead}>
        <Text style={styles.lang}>{lang || 'code'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy code" onPress={copy} hitSlop={10}><Text style={styles.copy}>{copied ? 'Copied' : 'Copy'}</Text></Pressable>
      </View>
      {/* Long lines scroll sideways inside the block, not the page. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeBody}>
        <View>{lines.map((line, index) => <View key={index} style={styles.codeLine}><Text style={styles.number}>{index + 1}</Text><Text style={styles.codeText} selectable>{line}</Text></View>)}</View>
      </ScrollView>
    </View>
  );
}

function CardBlock({block, onOpen}: {block: Card; onOpen(block: Card): void}) {
  const styles = useStyles();
  const title = CARD_TITLE[block.card];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}, open full screen`} disabled={block.open} onPress={() => onOpen(block)} style={styles.card}>
      <View style={styles.codeHead}><Text style={styles.lang}>{title}</Text><Text style={styles.copy}>{block.open ? 'Writing…' : '⤢'}</Text></View>
      <Text style={styles.cardSource} numberOfLines={7}>{block.code}</Text>
    </Pressable>
  );
}

const MdBlock = memo(function MdBlock({id, block, onOpen}: {id: string; block: Block; onOpen(block: Card): void}) {
  reportRender('md-block', id);
  const styles = useStyles(), c = useTheme();
  const style = useMemo(() => markdownStyle(c), [c]);
  if (block.kind === 'code') return <CodeBlock lang={block.lang} code={block.code} />;
  if (block.kind === 'card') return <CardBlock block={block} onOpen={onOpen} />;
  return <EnrichedMarkdownText markdown={block.text} flavor="github" markdownStyle={style} containerStyle={styles.prose} selectable />;
}, (a, b) => a.id === b.id && a.onOpen === b.onOpen && sameBlock(a.block, b.block));

export const Markdown = memo(function Markdown({text}: {text: string}) {
  const styles = useStyles();
  const blocks = useMemo(() => splitBlocks(text), [text]);
  const [full, setFull] = useState<Card | null>(null);
  return (
    <View style={styles.blocks}>
      {blocks.map((block, index) => <MdBlock key={index} id={String(index)} block={block} onOpen={setFull} />)}
      {full ? (
        <Modal visible animationType="fade" onRequestClose={() => setFull(null)} presentationStyle="fullScreen">
          <View style={styles.full} testID="rich-full-screen">
            <View style={styles.fullHead}>
              <Text style={styles.fullTitle}>{CARD_TITLE[full.card]}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setFull(null)} hitSlop={10} style={styles.close}><Text style={styles.copy}>Done</Text></Pressable>
            </View>
            <Text style={styles.note}>{`The ${CARD_TITLE[full.card].toLowerCase()}'s source, as the agent wrote it (${full.lang}).`}</Text>
            <ScrollView horizontal contentContainerStyle={styles.codeBody}><ScrollView><Text style={styles.codeText} selectable>{full.code}</Text></ScrollView></ScrollView>
          </View>
        </Modal>
      ) : null}
    </View>
  );
});
const useStyles = themed(c => StyleSheet.create({
  blocks: {gap: space.s},
  prose: {flexShrink: 1},
  code: {backgroundColor: c.surface, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden'},
  codeHead: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.m, paddingTop: space.s},
  lang: {color: c.faint, ...type.caption, fontFamily: font.mono},
  copy: {color: c.muted, ...type.caption, fontWeight: '600'},
  codeBody: {padding: space.m},
  codeLine: {flexDirection: 'row', gap: space.m},
  number: {color: c.faint, ...type.label, fontFamily: font.mono, minWidth: 18, textAlign: 'right'},
  codeText: {color: c.text, ...type.label, fontFamily: font.mono},
  card: {height: CARD_HEIGHT, backgroundColor: c.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden', gap: space.s},
  cardSource: {color: c.faint, ...type.caption, fontFamily: font.mono, paddingHorizontal: space.m},
  full: {flex: 1, backgroundColor: c.background, paddingTop: space.xl + space.l, gap: space.s},
  fullHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: touch, paddingHorizontal: space.l},
  fullTitle: {color: c.strong, ...type.headline, fontWeight: '600'},
  close: {position: 'absolute', right: space.l},
  note: {color: c.faint, ...type.caption, paddingHorizontal: space.l},
}));
