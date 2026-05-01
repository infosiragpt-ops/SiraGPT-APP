import rehypeKatex from "rehype-katex"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"

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
  },
}

export const markdownRehypePlugins = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
  rehypeKatex,
] as any[]
