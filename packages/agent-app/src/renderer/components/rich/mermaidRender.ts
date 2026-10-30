/**
 * Mermaid, loaded on first use (this module and the library are one lazy chunk; every diagram type is its own chunk behind
 * it). Rendering is serialized, started from an idle callback, themed from the active tokens and sanitized: Mermaid runs with
 * `securityLevel: 'strict'` and its SVG goes through DOMPurify again before it reaches the DOM.
 */
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import {mix, type RichTheme} from '../../richTheme';

export interface MermaidResult {svg: string; width: number; height: number}

/** The theme's colours as Mermaid's `base` theme variables. Every colour comes from the active tokens. */
export function mermaidThemeVariables(t: RichTheme): Record<string, unknown> {
  const p = t.palette, on = t.onPalette;
  const border = mix(t.accent, t.surface, 55);
  const quiet = mix(t.text, t.surface, 5), quieter = mix(t.text, t.surface, 8);
  const tint = (color: string, amount = 18) => mix(color, t.surface, amount);
  const variables: Record<string, unknown> = {
    darkMode: t.dark, background: t.surface, dropShadow: 'none', useGradient: false, fontFamily: t.font, fontSize: '13px',
    primaryColor: t.fill, primaryTextColor: t.text, primaryBorderColor: border,
    secondaryColor: tint(p[1]!), secondaryTextColor: t.text, secondaryBorderColor: tint(p[1]!, 60),
    tertiaryColor: tint(p[2]!), tertiaryTextColor: t.text, tertiaryBorderColor: tint(p[2]!, 60),
    lineColor: t.textDim, textColor: t.text, mainBkg: t.fill, nodeBorder: border, nodeTextColor: t.text,
    clusterBkg: quiet, clusterBorder: t.line, titleColor: t.text, edgeLabelBackground: t.surface,
    noteBkgColor: tint(p[2]!), noteTextColor: t.text, noteBorderColor: tint(p[2]!, 55),
    actorBkg: t.fill, actorBorder: border, actorTextColor: t.text, actorLineColor: t.line,
    signalColor: t.textDim, signalTextColor: t.text, labelBoxBkgColor: t.fill, labelBoxBorderColor: border, labelTextColor: t.text,
    loopTextColor: t.text, activationBkgColor: t.fillStrong, activationBorderColor: border, sequenceNumberColor: on[0],
    pieTitleTextColor: t.text, pieSectionTextColor: on[0], pieLegendTextColor: t.text, pieStrokeColor: t.surface, pieOuterStrokeColor: t.line, pieStrokeWidth: '2px', pieOpacity: '0.95',
    labelColor: t.text, altBackground: quiet, compositeBackground: t.surface, compositeTitleBackground: t.fill, specialStateColor: t.textDim, transitionColor: t.textDim, transitionLabelColor: t.text,
    attributeBackgroundColorOdd: t.surface, attributeBackgroundColorEven: quieter,
    gridColor: t.line, sectionBkgColor: quiet, altSectionBkgColor: t.surface, sectionBkgColor2: quieter,
    taskBkgColor: t.fillStrong, taskBorderColor: border, taskTextColor: t.text, taskTextLightColor: t.text, taskTextDarkColor: t.text, taskTextOutsideColor: t.text, taskTextClickableColor: t.accent,
    activeTaskBkgColor: tint(p[0]!, 45), activeTaskBorderColor: p[0],
    doneTaskBkgColor: tint(p[1]!, 35), doneTaskBorderColor: p[1],
    critBkgColor: tint(t.danger, 35), critBorderColor: t.danger, todayLineColor: t.danger,
    errorBkgColor: tint(t.danger, 30), errorTextColor: t.text,
    quadrant1Fill: tint(p[1]!, 14), quadrant2Fill: tint(p[0]!, 14), quadrant3Fill: tint(p[3]!, 14), quadrant4Fill: tint(p[2]!, 14),
    quadrant1TextFill: t.text, quadrant2TextFill: t.text, quadrant3TextFill: t.text, quadrant4TextFill: t.text,
    quadrantPointFill: t.accent, quadrantPointTextFill: t.text, quadrantXAxisTextFill: t.textDim, quadrantYAxisTextFill: t.textDim,
    quadrantTitleFill: t.text, quadrantInternalBorderStrokeFill: t.line, quadrantExternalBorderStrokeFill: t.line,
    commitLabelColor: t.text, commitLabelBackground: t.fill, tagLabelColor: t.text, tagLabelBackground: t.fill, tagLabelBorder: border,
    xyChart: {backgroundColor: t.surface, titleColor: t.text, xAxisLabelColor: t.textDim, xAxisTitleColor: t.text, xAxisTickColor: t.line, xAxisLineColor: t.line,
      yAxisLabelColor: t.textDim, yAxisTitleColor: t.text, yAxisTickColor: t.line, yAxisLineColor: t.line, plotColorPalette: p.join(',')},
  };
  p.forEach((color, index) => {
    variables[`pie${index + 1}`] = color;
    variables[`cScale${index}`] = color;
    variables[`cScaleLabel${index}`] = on[index];
    if (index < 8) { variables[`git${index}`] = color; variables[`gitBranchLabel${index}`] = on[index]; }
    if (index < 8) variables[`cScaleInv${index}`] = color;
  });
  return variables;
}

const sanitize = (svg: string): string => DOMPurify.sanitize(svg, {ADD_TAGS: ['foreignobject'], ADD_ATTR: ['dominant-baseline'], HTML_INTEGRATION_POINTS: {foreignobject: true}, FORBID_TAGS: ['script', 'iframe', 'object', 'embed']});

/** Natural size from the root element's viewBox; the root is rewritten to carry it explicitly (no 100% width, no max-width). */
export function normalizeSvg(svg: string): MermaidResult {
  const root = /<svg\b[^>]*>/i.exec(svg);
  if (!root) throw new Error('The diagram produced no drawing.');
  const viewBox = /viewBox="\s*(-?[\d.]+)[ ,]+(-?[\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)\s*"/i.exec(root[0]);
  let width = viewBox ? Number(viewBox[3]) : Number(/\swidth="([\d.]+)"/i.exec(root[0])?.[1]);
  let height = viewBox ? Number(viewBox[4]) : Number(/\sheight="([\d.]+)"/i.exec(root[0])?.[1]);
  if (!Number.isFinite(width) || width <= 0) width = 400;
  if (!Number.isFinite(height) || height <= 0) height = 300;
  let tag = root[0].replace(/\s(width|height)="[^"]*"/gi, '').replace(/\sstyle="[^"]*"/i, '');
  tag = tag.replace(/<svg\b/i, `<svg width="${width}" height="${height}"`);
  return {svg: svg.replace(root[0], () => tag), width, height};
}

let counter = 0, chain: Promise<unknown> = Promise.resolve(), configured = '';

export function renderMermaid(source: string, theme: RichTheme, signature: string): Promise<MermaidResult> {
  const job = chain.then(async () => {
    if (configured !== signature) {
      mermaid.initialize({
        // dagre, the classic layout: Mermaid 12's default pulls in ELK, a 1.4 MB library that takes ~90 ms just to evaluate. A diagram that asks for ELK
        // in its own front matter still gets it (its chunk loads then).
        startOnLoad: false, securityLevel: 'strict', layout: 'dagre', theme: 'base', themeVariables: mermaidThemeVariables(theme), fontFamily: theme.font, darkMode: theme.dark,
        suppressErrorRendering: true, logLevel: 'fatal', maxTextSize: 100_000, maxEdges: 600,
        flowchart: {useMaxWidth: false, htmlLabels: true}, sequence: {useMaxWidth: false}, gantt: {useMaxWidth: false}, journey: {useMaxWidth: false},
        class: {useMaxWidth: false}, state: {useMaxWidth: false}, er: {useMaxWidth: false}, pie: {useMaxWidth: false}, mindmap: {useMaxWidth: false},
        timeline: {useMaxWidth: false}, gitGraph: {useMaxWidth: false}, quadrantChart: {useMaxWidth: false}, xyChart: {useMaxWidth: false},
        requirement: {useMaxWidth: false}, c4: {useMaxWidth: false}, sankey: {useMaxWidth: false}, block: {useMaxWidth: false}, packet: {useMaxWidth: false},
        architecture: {useMaxWidth: false}, kanban: {useMaxWidth: false}, radar: {useMaxWidth: false},
      });
      configured = signature;
    }
    const id = `muster-mmd-${++counter}`;
    try {
      const {svg} = await mermaid.render(id, source);
      return normalizeSvg(sanitize(svg));
    } finally {
      // A failed render can leave its measuring node behind.
      document.getElementById(id)?.remove(); document.getElementById(`d${id}`)?.remove();
    }
  });
  chain = job.catch(() => undefined);
  return job;
}
