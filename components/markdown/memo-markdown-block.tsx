"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import { markdownRehypePlugins, markdownRemarkPlugins } from "@/lib/markdown-sanitize"

type Props = {
  content: string
  components: any
}

// Render a closed markdown block once and skip the entire parse +
// reconcile pass whenever the same content + components instance comes
// back. The custom comparator uses string equality on `content` and
// reference equality on `components`; the caller is responsible for
// stabilizing the components reference (useMemo with narrow deps).
const MemoMarkdownBlock = React.memo(
  function MemoMarkdownBlock({ content, components }: Props) {
    return (
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    )
  },
  (prev, next) =>
    prev.content === next.content && prev.components === next.components,
)

export default MemoMarkdownBlock
