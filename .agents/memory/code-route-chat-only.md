---
name: /code is chat-only by design
description: Why /code has no IDE chrome and must stay a pure agentic chat + live preview.
---

/code is intentionally a PURE agentic chat (owner gives orders, it builds) beside a
live PreviewPane — NO editor, file tree, terminal, command palette, or "Código"
button. The shell lives in `components/code/code-workspace.tsx`.

**Why:** Owner (Jorge) explicitly wants "solo un chat agéntico … tipo Replit" — he
should never see raw code/IDE surfaces, only the chat + the running app.

**How to apply:**
- Do NOT "restore" the editor/terminal/tools into `code-workspace.tsx` thinking they
  were lost — their component files (workspace-top-bar, status-bar, code-hub,
  editor-panel, terminal-panel, tool-launcher, tool-screen, command palette) are
  left on disk but intentionally unrendered.
- Thinking activity = red DotmCircular15. `THINKING_GLYPH_COLOR` (#FF0000) is the
  single source AND the component defaults its `color` to that constant, so a
  bare `<DotmCircular15 />` is red too; setting only the constant is NOT enough
  because color-less usages otherwise inherit `currentColor`.
- Open follow-up: code-block cards can still render inside the chat; hiding/summarizing
  them for /code needs `ai-code-chat-panel.tsx`.
