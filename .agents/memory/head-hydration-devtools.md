---
name: Head hydration mismatch from devtools injection
description: How to suppress React hydration warnings caused by browser/Replit devtools injecting scripts into <head>
---

## Rule
When Replit (or any browser extension) injects a `<script>` into `<head>` on the client, React sees a structural mismatch between its server-rendered fiber tree and the actual DOM. The fix requires `suppressHydrationWarning` on **both**:
1. The `<head>` element itself
2. The specific `<script>` child that gets compared against the injected node

Adding it only to `<head>` is insufficient — `suppressHydrationWarning` applies one level deep (the element's own attributes), not recursively to children.

**Why:** React walks `<head>` children in order. The devtools script is injected at position 0, shifting all of React's script elements. Without `suppressHydrationWarning` on the actual `<script>` element, React sees a positional mismatch and emits "A tree hydrated but some attributes of the server rendered HTML didn't match…"

**How to apply:** In `app/layout.tsx`, the JSON-LD `<script type="application/ld+json">` needs `suppressHydrationWarning` alongside `<head suppressHydrationWarning>`. This is dev-environment only (Replit injects `/__replco/static/devtools/injected.js`); production is unaffected.
