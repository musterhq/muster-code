// esbuild plugin shared by scripts/build.mjs and scripts/dependency-report.mjs. KaTeX's stylesheet lists each maths font as
// woff2, woff and ttf; Chromium always takes the woff2, so only that one is bundled (served from the app itself: the
// renderer's CSP allows fonts from 'self' only, never a CDN).
import {readFileSync} from 'node:fs';

export const katexFontsWoff2Only = {
  name: 'katex-fonts-woff2-only',
  setup(build) {
    build.onLoad({filter: /[\\/]katex[\\/]dist[\\/]katex(\.min)?\.css$/}, args => ({
      contents: readFileSync(args.path, 'utf8').replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, ''),
      loader: 'css',
    }));
  },
};
