"use client"

/**
 * markdown-html — thin round-trip layer used by the Tiptap editor.
 *
 * Why not tiptap-markdown? The package targets Tiptap v2; siraGPT
 * is on v3. Rather than wait on the upstream port, we use the two
 * battle-tested libs (`marked` for md→html, `turndown` for html→md)
 * and keep our wrapper small enough that swapping back to an
 * official extension later is a single-line change in the editor.
 *
 * Semantic notes:
 *   - We intentionally skip GFM table parsing in turndown's default
 *     rules because they emit brittle output; we'll add a proper
 *     table plugin if the editor starts emitting tables the
 *     default rules mangle.
 *   - We disable turndown's "reference-style" links so every link
 *     renders inline — matches what Tiptap's link extension emits
 *     and keeps the md source readable.
 *   - marked() receives `{ gfm: true, breaks: false }` because GFM
 *     table/strikethrough parsing is what users expect, but a
 *     single newline should NOT become a hard line break (that's
 *     Notion's behaviour too).
 */

import { marked } from "marked"
import TurndownService from "turndown"

// Configure marked once; `breaks:false` keeps paragraph semantics
// (single \n is a soft break, not a <br>) which matches Tiptap's
// default paragraph handling.
marked.setOptions({ gfm: true, breaks: false, pedantic: false })

// Turndown with sensible GFM-like defaults.
const turndown = new TurndownService({
  headingStyle: "atx",          // ## Heading (not underlined)
  bulletListMarker: "-",        // - item  (not * or +)
  codeBlockStyle: "fenced",     // ```lang\n…\n```
  emDelimiter: "_",             // _italic_ (easier to type; ** still bold)
  linkStyle: "inlined",
  linkReferenceStyle: "full",
})

// Keep task-list checkboxes alive: GFM `- [x] done / - [ ] todo`.
// Turndown's default rules strip them because <input> isn't in its
// allowed-elements table. This rule pulls the checkbox state out of
// the Tiptap Task extension's DOM (`<li data-type="taskItem" data-checked="true">`).
turndown.addRule("taskItem", {
  filter: (node) =>
    node.nodeName === "LI" &&
    (node as HTMLElement).getAttribute("data-type") === "taskItem",
  replacement: (content, node) => {
    const el = node as HTMLElement
    const checked = el.getAttribute("data-checked") === "true"
    const box = checked ? "[x]" : "[ ]"
    // Turndown passes `content` with trailing newline; trim so we
    // don't end up with blank rows between items.
    return `- ${box} ${content.replace(/^\s+|\s+$/g, "")}\n`
  },
})

/**
 * Markdown → HTML for loading a saved document into the editor.
 */
export function mdToHtml(md: string): string {
  if (!md) return ""
  try { return marked.parse(md) as string } catch { return "" }
}

/**
 * HTML → Markdown for persistence. Accepts the editor's raw HTML
 * (Tiptap's getHTML()).
 */
export function htmlToMd(html: string): string {
  if (!html) return ""
  try { return turndown.turndown(html) } catch { return "" }
}
