"use client"

import * as React from "react"
import { tokenizeUserText } from "@/lib/chat/user-text-tokens"

/**
 * The user's own message, rendered as what it contains: links as celeste
 * anchors (full URL in the tooltip, bounded display), e-mails as mailto,
 * file names as mono chips, timecodes as tabular figures, `code` as code.
 * Whitespace is preserved by the parent (.chat-user-bubble-inner is
 * pre-wrap). Plain text renders exactly as before.
 */
export function RichUserText({ text }: { text: string }) {
  const tokens = React.useMemo(() => tokenizeUserText(text), [text])
  if (!tokens.length) return null
  if (tokens.length === 1 && tokens[0].type === "text") return <>{tokens[0].value}</>
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}-${index}`
        switch (token.type) {
          case "url":
            return (
              <a
                key={key}
                href={token.href}
                target="_blank"
                rel="noopener noreferrer"
                title={token.href}
                className="chat-user-link"
                data-testid="chat-user-link"
                onClick={(event) => event.stopPropagation()}
              >
                {token.display}
              </a>
            )
          case "email":
            return (
              <a key={key} href={token.href} className="chat-user-link chat-user-email" data-testid="chat-user-email" onClick={(event) => event.stopPropagation()}>
                {token.value}
              </a>
            )
          case "file":
            return (
              <span key={key} className="chat-user-file" data-testid="chat-user-file" data-ext={token.ext}>
                {token.value}
              </span>
            )
          case "timecode":
            return (
              <span key={key} className="chat-user-timecode" data-testid="chat-user-timecode">
                {token.value}
              </span>
            )
          case "code":
            return (
              <code key={key} className="chat-user-code" data-testid="chat-user-code">
                {token.value}
              </code>
            )
          default:
            return <React.Fragment key={key}>{token.value}</React.Fragment>
        }
      })}
    </>
  )
}
