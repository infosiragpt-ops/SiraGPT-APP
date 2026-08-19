import rehypeAutolinkHeadings from "rehype-autolink-headings"
import rehypeKatex from "rehype-katex"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import rehypeSlug from "rehype-slug"
import remarkDirective from "remark-directive"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"

import { CALLOUT_KINDS, remarkCallouts } from "./markdown/remark-callouts"

const agenticSearchClassNames = [
  "agentic-search-status",
  "agentic-search-status__bars",
  "agentic-search-status__chip",
  "agentic-search-status__chips",
  "agentic-search-status__counter",
  "agentic-search-status__elapsed",
  "agentic-search-status__head",
  "agentic-search-status__hint",
  "agentic-search-status__label",
  "agentic-search-status__progress",
]

const progressValuePattern = /^(?:100|[1-9]?\d)$/
const searchActivityIdPattern = /^[A-Za-z0-9:_-]{1,96}$/
const calloutClassNames = ["callout", ...CALLOUT_KINDS.map((kind) => `callout-${kind}`)]

export const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), "button", "progress"],
  attributes: {
    ...defaultSchema.attributes,
    button: [
      ...(defaultSchema.attributes?.button || []),
      ["className", "agentic-search-status"],
      ["role", "status"],
      ["type", "button"],
      ["ariaLive", "polite"],
      "ariaLabel",
      ["dataSearchActivityId", searchActivityIdPattern],
    ],
    progress: [
      ...(defaultSchema.attributes?.progress || []),
      ["className", "agentic-search-status__progress"],
      ["max", "100"],
      ["value", progressValuePattern],
    ],
    span: [
      ...(defaultSchema.attributes?.span || []),
      ["className", ...agenticSearchClassNames],
      ["ariaHidden", "true"],
    ],
    // remark-callouts emits a curated shape for `:::note` / `:::warning`
    // / `:::tip` / `:::info` / `:::caution` blocks. The class list is
    // pinned so an LLM cannot smuggle arbitrary CSS hooks; the data-
    // attribute is opt-in for analytics / styling consumers.
    aside: [
      ...(defaultSchema.attributes?.aside || []),
      ["className", ...calloutClassNames],
      ["role", "note"],
      ["dataCalloutKind", ...CALLOUT_KINDS],
    ],
    // rehype-autolink-headings appends an `<a class="anchor">` inside
    // every heading once rehype-slug has minted the id. Keep the link
    // shape narrow: class + href, plus ARIA hooks for assistive tech.
    a: [
      ...(defaultSchema.attributes?.a || []),
      ["className", "anchor", "anchor-link"],
      ["ariaHidden", "true"],
      ["dataHeadingAnchor", "true"],
      ["tabIndex", "-1", "0"],
    ],
  },
}

// Order matters:
//   1. rehypeRaw                — preserve any raw HTML the markdown carried in.
//   2. rehypeSanitize           — strip everything not on the schema. Anchor +
//                                 callout shapes are explicitly whitelisted above.
//   3. rehypeKatex              — math rendering on the sanitized tree.
//   4. rehypeSlug               — mint deterministic ids on h1–h6 (post-sanitize
//                                 so the id survives through every transform that
//                                 might rewrite text content).
//   5. rehypeAutolinkHeadings   — append the anchor `<a>` last; it relies on the
//                                 ids minted by slug and is tolerated by sanitize
//                                 because we whitelisted the shape above.
export const markdownRehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeKatex,
  rehypeSlug,
  [
    rehypeAutolinkHeadings,
    {
      behavior: "append",
      properties: {
        className: ["anchor", "anchor-link"],
        ariaHidden: "true",
        tabIndex: -1,
      },
    },
  ],
] as any[]

// Single source of truth for the remark stage. Components that render
// chat content should import this rather than re-listing the plugins,
// otherwise a new plugin (e.g. `remarkCallouts`) silently doesn't apply
// to surfaces that forgot to update their array. `remarkDirective` MUST
// be listed before `remarkCallouts` so the directive nodes exist when
// the callout transform visits the tree.
export const markdownRemarkPlugins = [
  remarkGfm,
  remarkMath,
  remarkDirective,
  remarkCallouts,
] as any[]
