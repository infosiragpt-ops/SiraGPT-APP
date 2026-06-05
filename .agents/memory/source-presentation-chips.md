---
name: Source presentation as chips at message bottom
description: How SiraGPT renders web/search sources as clean chips at the end of a message instead of inline clutter.
---

# Sources as chips at the bottom (not inline)

The model is instructed (SOURCE INTEGRITY CONTRACT in master-prompt.js) to write
clean prose with NO raw URLs / engine markers inline, and to list every source
once at the END under a heading named exactly `## Fuentes` (`## Sources` in
English) as a numbered markdown list of links (one link per line).

The frontend (components/message-component.tsx markdown renderer) then turns any
**link-only list item** into a ChatGPT-style chip (pill with a globe icon), and a
list whose items are all link-only into a `flex flex-wrap` row of chips.

**Why scope to link-only `<li>`, not the global `<a>` renderer:** an earlier
attempt styled every `<a>` as a chip, which forced *inline prose links* into pills
too. Scoping the chip to list items that contain only a link keeps normal inline
links as plain underlined links while the Fuentes section renders as chips.

**How to apply:** if you change the chip look, edit `SOURCE_CHIP_CLASS` /
`renderSourceChip` and the `ul`/`ol`/`li` renderers — keep the plain inline `a`
renderer untouched. The detection relies on the model emitting sources as a
markdown list; the contract wording and the renderer must stay in sync.
