"use client"

/**
 * Side-by-side / unified Monaco diff for the /agentes coding IDE.
 * Uses the existing @monaco-editor/react package (already in package.json).
 */

import { DiffEditor } from "@monaco-editor/react"

type Props = {
  original: string
  modified: string
  language: string
  path?: string
  sideBySide: boolean
}

export function CodingMonacoDiff({ original, modified, language, sideBySide }: Props) {
  return (
    <DiffEditor
      height="100%"
      original={original}
      modified={modified}
      language={language}
      theme="vs-dark"
      options={{
        readOnly: true,
        renderSideBySide: sideBySide,
        minimap: { enabled: false },
        wordWrap: "on",
        fontSize: 13,
        scrollBeyondLastLine: false,
      }}
    />
  )
}

export default CodingMonacoDiff
