"use client"

/**
 * MonacoCodeArea — code editor surface backed by Monaco (the engine
 * that powers VS Code, GitHub.dev, Cursor). Lazy-loaded by the parent
 * via `next/dynamic` because the bundle is heavy (~2 MB) and the rest
 * of the workspace must stay interactive while the editor hydrates.
 *
 * API matches the previous textarea-based CodeArea so the parent
 * component can swap implementations without other changes:
 *   - value: current text
 *   - onChange(next): mutator
 *   - language: hint for syntax highlighting
 *   - path:    shown in the header strip; also fed to Monaco as the
 *              model URI so language services key per-file.
 *
 * This module is a CLIENT component AND must never run in SSR — Monaco
 * touches `window` and `document` at module scope. Always import via
 * `next/dynamic({ ssr: false })`.
 */

import * as React from "react"
import Editor, { type OnChange, type OnMount } from "@monaco-editor/react"
import { FileCode2 } from "lucide-react"

import { cn } from "@/lib/utils"

type Props = {
  value: string
  language: string
  onChange: (value: string) => void
  path: string
}

// Map the file-extension language hints we already pass into the
// editor to Monaco's canonical language IDs. Anything unmapped falls
// through to `plaintext`, which still gets the editor's other affordances
// (line numbers, find / replace, multi-cursor) without false-positive
// highlighting. Keep this list aligned with the project's code-detection
// vocabulary; expanding it is cheap.
const LANGUAGE_ALIAS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  go: "go",
  rs: "rust",
  rust: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  svg: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  graphql: "graphql",
  dockerfile: "dockerfile",
}

function resolveMonacoLanguage(hint: string): string {
  const normalized = hint.trim().toLowerCase()
  return LANGUAGE_ALIAS[normalized] || "plaintext"
}

export default function MonacoCodeArea({ value, language, onChange, path }: Props) {
  const handleChange = React.useCallback<OnChange>(
    (next) => {
      // Monaco emits `undefined` when the model is being torn down.
      // Treat that as a no-op rather than wiping the file content.
      if (typeof next !== "string") return
      onChange(next)
    },
    [onChange],
  )

  const handleMount = React.useCallback<OnMount>((editor, monaco) => {
    // Match the textarea's tab=2 convention so paste-from-textarea
    // doesn't introduce mixed indentation when both surfaces touch
    // the same file. The detect-indentation default would otherwise
    // override this on file open.
    editor.updateOptions({ tabSize: 2, insertSpaces: true, detectIndentation: false })
    // Disable the inline marker noise on read-only / quick views —
    // we don't ship the language workers for every alias above, so
    // unactionable squiggles would just be visual debt.
    monaco.languages?.typescript?.typescriptDefaults?.setDiagnosticsOptions?.({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    })
    monaco.languages?.typescript?.javascriptDefaults?.setDiagnosticsOptions?.({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    })
  }, [])

  const monacoLanguage = React.useMemo(() => resolveMonacoLanguage(language), [language])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/40 bg-muted/20 px-3 text-[11px] uppercase tracking-wide text-muted-foreground">
        <FileCode2 className="h-3 w-3" />
        <span className="truncate">{path}</span>
        <span className="ml-auto opacity-70">{language}</span>
      </div>
      <div className={cn("min-h-0 flex-1")}>
        <Editor
          height="100%"
          path={path}
          language={monacoLanguage}
          value={value}
          theme="vs-dark"
          onChange={handleChange}
          onMount={handleMount}
          options={{
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            fontSize: 13,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            renderLineHighlight: "line",
            smoothScrolling: true,
            // Trim the gutter so the editor visually fits the chat
            // surface; Monaco's defaults are sized for a full IDE.
            lineNumbersMinChars: 3,
            scrollbar: {
              vertical: "auto",
              horizontal: "auto",
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
          }}
        />
      </div>
    </div>
  )
}
