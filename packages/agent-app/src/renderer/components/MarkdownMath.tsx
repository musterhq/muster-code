/* Portions adapted from T3 Code (https://github.com/pingdotgg/t3code, commit fa4f3a2), apps/web/src/components/chat/MarkdownMath.tsx. Copyright (c) 2026 T3 Tools Inc., MIT License; see THIRD-PARTY-NOTICES.md and licenses/t3code-MIT.txt. */
/**
 * One formula in a reply (#785). Shows its TeX until KaTeX has loaded, and keeps showing it when KaTeX cannot parse it (a
 * typo, or a command KaTeX lacks). Copying any part of it copies the whole formula as written, delimiters included
 * (`data-markdown-copy`, read by markdown-clipboard.ts). KaTeX itself is a lazy chunk; its stylesheet is imported here so
 * main.css carries it, and its fonts are bundled with the app (scripts/build.mjs), never fetched.
 */
import React, {Suspense} from 'react';
import './markdown-math.css';

const MathTypeset = React.lazy(() => import('./MathTypeset'));

/** Warms the KaTeX chunk, e.g. when a reply that holds maths first renders. */
export function preloadMath(): void { void import('./MathTypeset').catch(() => {}); }

class SourceOnError extends React.Component<{fallback: React.ReactNode; tex: string; children: React.ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError(): {failed: boolean} { return {failed: true}; }
  componentDidUpdate(previous: {tex: string}): void { if (previous.tex !== this.props.tex && this.state.failed) this.setState({failed: false}); }
  render(): React.ReactNode { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** The formula as a person would retype it, when the reply's own text is not at hand. */
export function mathSource(tex: string, display: boolean): string {
  return display ? `\\[\n${tex}\n\\]` : `\\(${tex}\\)`;
}

/** `block`: a display formula on its own lines (it copies as its own paragraph); `$$…$$` within a sentence is display style but inline. */
export const MarkdownMath = React.memo(function MarkdownMath({tex: raw, display, source, block = false}: {tex: string; display: boolean; source?: string; block?: boolean}): React.ReactElement {
  const tex = raw.trim();
  const written = source?.trim() || mathSource(tex, display);
  const fallback = <span className="md-math-source">{written}</span>;
  return (
    <span
      className={display ? 'md-math md-math-display' : 'md-math md-math-inline'}
      data-markdown-math={display ? 'display' : 'inline'}
      data-markdown-copy={block ? `${written}\n\n` : written}
      role="group"
      aria-label={display ? 'Display equation' : 'Inline equation'}
    >
      {/* Display maths wider than the reply scrolls sideways; the scroller takes focus so the keyboard can scroll it too. */}
      <span className="md-math-scroll" {...(display ? {tabIndex: 0, 'aria-label': 'Scroll display equation'} : {})}>
        <SourceOnError tex={tex} fallback={fallback}>
          <Suspense fallback={fallback}>
            <MathTypeset tex={tex} display={display} fallback={fallback}/>
          </Suspense>
        </SourceOnError>
      </span>
    </span>
  );
});
