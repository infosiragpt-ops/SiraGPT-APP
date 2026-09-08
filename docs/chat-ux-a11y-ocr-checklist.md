# Chat UX / a11y / OCR — 15-item checklist

Maps each requested fix to the files that implement it. Scope is `/chat` only; `/code` UI lock files were not edited.

| # | Fix | Files |
|---|---|---|
| 1 | Attachments live inside the user message (`msg--user`) and align with the text on `flex-end` | `components/message-component.tsx`, `app/globals.css` (`.msg--user`, `.msg-user-stack`) |
| 2 | Image attachments never upscale past 1× `naturalWidth`; pixelation only in the zoom viewer | `components/message-component.tsx` (`UserChatImage`), `app/globals.css` (`.chat-user-image`, `.chat-image-zoom`) |
| 3 | Code blocks use `--code-bg` / `--code-fg` (WCAG ≥ 4.5:1). No light-on-light pill on navy | `components/ui/custom-code-block.tsx`, `app/globals.css` (`.chat-code-block`) |
| 4 | Code copy button + `aria-live`, language label, URL linkification for OCR | `components/ui/custom-code-block.tsx`, `lib/chat/code-block-utils.ts` |
| 5 | One `--content-max: 46rem` (~65–75ch) shared by messages, attachments, composer | `app/globals.css` (`--content-max`, `--chat-content-max-width`) |
| 6 | Kill ~700px dead space: flex column `justify-end`, `overflow-anchor: auto`, `100dvh` | `app/globals.css` (`.chat-viewport`, `.chat-message-scroll-content`) |
| 7 | Thinking disclosure as `<details><summary>` or `aria-expanded` + SVG rotate; `prefers-reduced-motion` | `components/claude-thinking-timeline.tsx`, `components/agent-trace.tsx`, `app/globals.css` (`.think-chevron`) |
| 8 | Action bar: copy / regen / 👍 / 👎 primary; rest under `⋯`; every icon `aria-label` + `title` | `components/MessageActionRail.tsx` |
| 9 | Brand aliases only — "Sira Pro" / "Sira Rápido". DeepSeek stays backend-only | `lib/chat/brand-label.ts`, `components/chat-interface-enhanced.tsx`, `components/MessageActionRail.tsx`, `components/message-component.tsx` |
| 10 | Design tokens `--brand`, `--chat-accent`, `--surface-1/2/3`; `color-scheme` + light/dark | `app/globals.css` (`:root` / `.dark`). Shadcn `--accent` (HSL components) is preserved so `hsl(var(--accent))` keeps working. |
| 11 | Send button disabled only when empty/busy; active = `--brand`; `:focus-visible` 2px outline | `components/chat/ChatComposerSurface.tsx`, `app/globals.css` (`.composer-send-button`) |
| 12 | Body line-height 1.6 + `clamp()` sizes; assistant paragraphs no longer ~2.0 | `app/globals.css`, `components/message-component.tsx` (`leading-[1.6]`) |
| 13 | Collapsible sidebar with history (`content-visibility`) + visible credits; desktop sidebar kept | `components/app-sidebar.tsx`, `components/chat-interface-enhanced.tsx` (`SidebarTrigger` when collapsed + `CreditsBadge`) |
| 14 | OCR preprocess: 3–4× canvas, adaptive threshold, deskew, Tesseract first pass, enlarge-retry **before** the model answers. Server path upscales tiny banners and adds ±3° deskew | `lib/chat/ocr-preprocess.ts`, `lib/document-service.ts`, `components/chat-interface-enhanced.tsx`, `backend/src/services/ocr-engine.js` |
| 15 | Chat log `role="log"` `aria-live="polite"` `aria-relevant="additions"`; focus moves to a sentinel at end of turn | `components/chat-interface-enhanced.tsx` |

## /code UI lock

No files under `components/code/**` or `app/code/**` were changed. After the `/chat` edits, `docs/UI_LOCK_HASHES.txt` was re-baselined with `npm run ui-lock:update`. Verify with `npm run ui-lock:verify` — the lock must stay green and `/code` must not grow "Arrancando" or "Panel/Controlar".
