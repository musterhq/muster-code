# Liquid Glass and material surfaces

## Decision

Use a small, token-driven material layer in the existing vanilla webview. Apply it to app chrome and transient controls only: the top bar, tab strip, command/search surfaces, popovers, and selected rows. Keep the transcript, editor, diff views, file trees, and other dense content on opaque surfaces for contrast, text selection, and stable rendering.

The webview implementation is a **CSS glass approximation**, even when it uses `backdrop-filter`. It must not be described as native Liquid Glass. A true native treatment would require the host window to opt into macOS AppKit composition. Electron exposes window-level `vibrancy` and `visualEffectState` options from the main process; an extension webview cannot set those options itself. If the Code OSS shell later adds a host-owned native surface, it can use native vibrancy for the chrome layer while retaining these same webview tokens and accessibility fallbacks.

This is a bounded extension of the current CSS approach, with no UI-library migration. The existing `agent-polish.ts` glass rules already demonstrate the right fallback shape: an opt-in attribute, a `backdrop-filter` path, a non-blurred fallback, and reduced-transparency/high-contrast overrides. The product workbench’s custom title bar remains a host seam; native vibrancy should be proposed to the shell owner rather than simulated by adding more blur to content.

## Small component contract

The frontend can use this contract without coupling components to a specific rendering technology:

```ts
type MaterialMode = "opaque" | "web-glass" | "native-vibrancy";
type MaterialLayer = "chrome" | "control" | "content";

interface MaterialSurface {
  mode: MaterialMode;
  layer: MaterialLayer;
  tint: "neutral" | "accent" | "selection";
  opacity: number;
  blurPx: number;
  border: "none" | "subtle" | "focus";
  reducedTransparency: "opaque" | "dimmed";
}
```

Required behavior:

- `content` always resolves to `opaque`, regardless of the requested mode. Code, diffs, transcript text, and file content never depend on blur behind them.
- `web-glass` is opt-in and uses one static backdrop blur value per surface. Do not animate blur, opacity, or a simulated refraction effect during typing, streaming, or scrolling.
- `native-vibrancy` is an environment capability reported by the host. Webview code must fall back to `web-glass`, then to `opaque`, without assuming native support.
- `prefers-reduced-transparency`, forced-colors, high-contrast, and the product’s explicit reduced-transparency setting resolve every surface to `opaque` or `dimmed`, with borders and selection colors carrying hierarchy.
- A surface must expose an accessible focus outline and preserve readable foreground/background contrast in both dark and light themes.

For the supplied Spotlight-like reference, model one floating `chrome` or `control` surface: a dark neutral tint, a subtle one-pixel rim, a static 12–16px radius, and a selected-row tint with stronger contrast. The screenshot’s floating panel is a useful composition reference, not evidence that the webview has native macOS glass.

## Host and platform boundary

Apple’s materials guidance describes materials as depth and layering tools and advises reserving Liquid Glass for controls and navigation over visually rich content. Standard materials are appropriate for content surfaces, and transparency must respect accessibility settings. AppKit’s `NSVisualEffectView` supplies native materials and blending modes to native views.

Electron’s `BrowserWindow`/`BaseWindow` APIs expose macOS `vibrancy` material names such as `sidebar`, `popover`, `menu`, `window`, and `content`, plus `visualEffectState` (`followWindow`, `active`, or `inactive`). These are main-process window settings. Transparent windows can produce composition artifacts, and changing vibrancy is a host concern; the extension layer should not depend on it.

Primary references:

- [Apple Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple Technology Overview: Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/liquid-glass)
- [Apple AppKit: NSVisualEffectView](https://developer.apple.com/documentation/appkit/nsvisualeffectview)
- [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron BaseWindow](https://www.electronjs.org/docs/latest/api/base-window)

## Bounded implementation path

1. Frontend defines the contract above as shared material tokens and maps `MaterialSurface` to existing CSS variables and classes.
2. Keep the glass opt-in at the root/chrome surface so content cannot inherit it accidentally.
3. Add a host capability bit only when the shell can truthfully report native vibrancy. Until then, emit `web-glass` or `opaque` only.
4. Verify reduced-transparency, forced-colors, light/dark themes, keyboard focus, streaming text, and large diffs with the existing frontend harness.

No new UI dependency is justified for this surface. A library would add migration and styling indirection without granting access to AppKit’s native composition. Native vibrancy, if pursued, belongs in a separately owned shell change with measured startup, memory, and text-rendering behavior.

## Current risks and limits

The current source has CSS glass rules but no native Electron vibrancy bridge. The webview cannot guarantee that backdrop sampling is available in every host configuration, so the opaque fallback is part of the product behavior. Blur cost and contrast can still vary by GPU, OS appearance, and host transparency settings; avoid treating the visual match to the reference screenshot as a functional requirement.
