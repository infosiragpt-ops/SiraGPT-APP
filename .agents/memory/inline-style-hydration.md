---
name: Inline style tags hydration mismatch
description: styled-jsx and raw <style> tags inside SSR'd client components cause React hydration errors — the fix is globals.css.
---

## The rule
Never put `<style jsx global>` (styled-jsx) or bare `<style>` tags with `@keyframes` inside client components that are server-rendered. Move all keyframe animations to `app/globals.css`.

**Why:** styled-jsx's `jsx global` tag injects styles into `<head>` on the client but renders the `<style>` node inline in the component tree on the server. This structural difference triggers React's hydration mismatch error (`unhandlederror` event), which Replit's crash detector interprets as a runtime crash — even though the app is running correctly and React recovers automatically.

A plain `<style>` tag (without `precedence`) also risks the same mismatch in React 19 if the injection path differs between server and client renders.

**How to apply:** If a component needs a custom `@keyframes` animation:
1. Add the `@keyframes` block to `app/globals.css` (with a comment identifying the owning component).
2. Reference the animation name in the component's `style` or `className` as usual — no `<style>` tag needed.
3. The `precedence` prop on `<style>` is the React 19 safe way to inline styles, but for simple keyframes globals.css is simpler and avoids all risk.

## What was fixed
- `BottomGlowBar.tsx`: `<style jsx global>` with `glow-slide`, `glow-hue`, `comet-sweep`, `comet-sweep-rev`
- `AuthNavButtons.tsx`: `<style>` with `login-beam`
- Both sets of keyframes moved to `app/globals.css`
- Also removed the `loading` fallback from `root-providers-dynamic.tsx` (`RootProviders` ssr:false) — the `<span sr-only>` placeholder caused a secondary structural mismatch between the server's loading state and the client's full provider tree.
