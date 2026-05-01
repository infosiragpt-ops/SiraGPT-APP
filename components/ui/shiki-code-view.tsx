"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { useShikiHighlight } from "@/lib/use-shiki-highlight"

type ShikiCodeViewProps = {
  code: string
  language?: string
  theme?: string
  showLineNumbers?: boolean
  wrapLongLines?: boolean
  className?: string
  codeClassName?: string
  maxHeight?: number | string
}

export function ShikiCodeView({
  code,
  language = "text",
  theme = "one-dark-pro",
  showLineNumbers = false,
  wrapLongLines = false,
  className,
  codeClassName,
  maxHeight,
}: ShikiCodeViewProps) {
  const highlighted = useShikiHighlight(code, language, theme)
  const lines = React.useMemo(() => code.split(/\r\n|\r|\n/).length || 1, [code])
  const containerStyle = maxHeight ? { maxHeight } : undefined

  const codeHostClassName = cn(
    "shiki-host min-w-0 text-[13px] leading-[1.55] [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:p-4 [&_code]:bg-transparent [&_code]:font-mono",
    wrapLongLines
      ? "[&_pre]:whitespace-pre-wrap [&_code]:break-all"
      : "[&_pre]:min-w-max [&_pre]:whitespace-pre",
    codeClassName,
  )

  const fallback = (
    <pre
      className={cn(
        "m-0 p-4 font-mono text-[13px] leading-[1.55] text-zinc-100",
        wrapLongLines ? "whitespace-pre-wrap break-all" : "min-w-max whitespace-pre",
      )}
    >
      <code>{code}</code>
    </pre>
  )

  if (!showLineNumbers) {
    return (
      <div className={cn("overflow-auto bg-zinc-950", className)} style={containerStyle}>
        {highlighted ? (
          <div className={codeHostClassName} dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : fallback}
      </div>
    )
  }

  return (
    <div className={cn("overflow-auto bg-zinc-950", className)} style={containerStyle}>
      <div className="grid min-w-max grid-cols-[auto_1fr]">
        <pre className="m-0 select-none border-r border-white/10 px-3 py-4 text-right font-mono text-[13px] leading-[1.55] text-zinc-500">
          {Array.from({ length: lines }, (_, index) => index + 1).join("\n")}
        </pre>
        {highlighted ? (
          <div className={codeHostClassName} dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : fallback}
      </div>
    </div>
  )
}
