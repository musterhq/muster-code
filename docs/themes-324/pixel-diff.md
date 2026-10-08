# Default-theme pixel diff (#324)

Headless Chrome, 1440x900, isolated instance, scripted provider. BEFORE = origin/main 82e72d6, AFTER = this branch. No theme chosen. Tolerance 0 (every channel of every pixel compared).

| screen | light: differing px / max delta | dark: differing px / max delta |
|---|---|---|
| 1-new-chat | 4 / 2 | 0 / 0 |
| 2-composer | 0 / 0 | 0 / 0 |
| 3-chat-markdown | 1 / 2 | 0 / 0 |
| 4-markdown-message | 0 / 0 | 0 / 0 |
| 5-sidebar | 0 / 0 | 0 / 0 |
| 6-project | 0 / 0 | 0 / 0 |
| 7-new-task-dialog | 0 / 0 | 0 / 0 |
| 8-task | 0 / 0 | 0 / 0 |
| 9-settings-general | 0 / 0 | 0 / 0 |
| 10-settings-appearance | 254939 / 255 | 256751 / 227 |

- 17 of 20 captures are pixel-identical (max delta 0). Settings > Appearance differs by design (the new theme picker rows). new-chat (light) 4 px and chat-markdown (light) 1 px (max delta 2) are Chrome first-capture render noise: two captures of the unchanged origin/main build differ by exactly the same pixels, and a second before/after pair is identical (0 px, max delta 0) for both screens.
- Settings > General (unchanged section) is identical in Light and Dark.
