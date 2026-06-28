---
name: /code is chat-only by design
description: Why /code has no IDE chrome and must stay a pure agentic chat + live preview.
---

/code is intentionally a PURE agentic chat (user gives orders, it builds) beside a
live PreviewPane — NO editor, file tree, terminal, command palette, or "Código"
button. The shell lives in `components/code/code-workspace.tsx`.

**Why:** The product owner explicitly wants "solo un chat agéntico … tipo Replit" —
they should never see raw code/IDE surfaces, only the chat + the running app.

**How to apply:**
- Do NOT "restore" the editor/terminal/tools into `code-workspace.tsx` thinking they
  were lost — their component files are left on disk but intentionally unrendered.
- Keep the surface chat-first: anything that exposes raw code/IDE chrome to the user
  (including verbose code-block cards inside the chat) works against the design intent.
