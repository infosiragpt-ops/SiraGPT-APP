---
name: Web-search source presentation (Fuentes chip + Actividad drawer)
description: How SiraGPT surfaces web-search sources — app-rendered chip next to the action rail, not inline markdown.
---

# Web-search sources are app-rendered, not model-rendered

Web-search results are surfaced by the application UI, NOT by the model writing a
markdown source list. The model is instructed (SOURCE PRESENTATION directive in
master-prompt.js) to write clean prose and NOT emit a `## Fuentes` heading or raw
URLs for web-search results. The academic/APA bibliography exception stays: when
the user explicitly wants citations/references, the model still writes them.

The backend carries structured sources end-to-end: the web-search adapter returns
`{ query, sources:[{title,url,snippet,domain,confidence}] }`; the chat route emits
them over SSE as a `web_sources` event AND persists them into the assistant
message metadata (`webSources` + `webSearchMeta`) so reloaded turns keep them.

The frontend renders a single `SourcesChip` (favicon "burbujitas" + `Fuentes N`
label) next to the message action rail for ASSISTANT, non-streaming messages that
have sources. Clicking it opens a right-side portal "Actividad" drawer with the
search steps, elapsed time, and the full source list. A module-scope
`extractWebSources(message)` reads live `message.sources/searchActivity` first,
then falls back to parsing persisted `message.metadata` JSON.

**Why:** the earlier approach turned link-only markdown `<li>`s into inline chips,
which depended on the model emitting a `## Fuentes` list and cluttered the body.
The app-level chip+drawer matches ChatGPT's UX and is decoupled from model output.

**How to apply:**
- Untrusted source URLs must be protocol-allowlisted (http/https only) before going
  into an anchor `href` — `safeHref()` in SourcesChip.tsx. Never render a raw
  source URL as an href without it (javascript:/data: XSS risk).
- The old inline link-list-to-chip markdown transformation was removed; do not
  reintroduce it. Sources live only in the chip/drawer.
