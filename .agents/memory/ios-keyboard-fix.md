---
name: iOS Safari keyboard — input bar positioning
description: How to keep the chat composer bar visible above the iOS keyboard
---

## The rule
On iOS Safari, the chat composer must use `position: fixed; bottom: 0` (not sticky) when the keyboard is open.

**Why:** `position: sticky` inside a flex column with `overflow: hidden` loses its anchor when iOS force-scrolls the main document on input focus. The bar ends up at the top of the visible area instead of the bottom. On iOS Safari, `position: fixed` elements are anchored to the **visual viewport** (area above keyboard), so `bottom: 0` always keeps the bar visible above the keyboard.

**How to apply:**
- Gate with `@supports (-webkit-touch-callout: none)` + `@media (max-width: 767px)` to target iOS only.
- When `.chat-viewport[data-chat-keyboard="open"]`, override `.chat-composer-dock` to `position: fixed; bottom: 0; left: 0; right: 0; z-index: 40`.
- The `data-chat-keyboard` attribute is set by `useVisualViewportCssVars` hook in `hooks/use-visual-viewport-css-vars.ts`.
- The existing `padding-bottom: var(--chat-composer-height)` on `.chat-message-scroll-content` already reserves scroll space — no extra change needed.
