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
import Editor, { type BeforeMount, type OnChange, type OnMount } from "@monaco-editor/react"

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

// Refined dark theme — a GitHub-Dark-inspired palette that reads cleaner
// and more professional than the stock `vs-dark` (softer background, calmer
// token hues, dimmed line numbers). Defined once before the editor mounts.
const handleBeforeMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme("sira-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6e7681", fontStyle: "italic" },
      { token: "keyword", foreground: "ff7b72" },
      { token: "keyword.control", foreground: "ff7b72" },
      { token: "string", foreground: "a5d6ff" },
      { token: "string.escape", foreground: "7ee787" },
      { token: "number", foreground: "79c0ff" },
      { token: "regexp", foreground: "7ee787" },
      { token: "type", foreground: "ffa657" },
      { token: "type.identifier", foreground: "ffa657" },
      { token: "function", foreground: "d2a8ff" },
      { token: "identifier", foreground: "c9d1d9" },
      { token: "variable", foreground: "c9d1d9" },
      { token: "variable.predefined", foreground: "79c0ff" },
      { token: "constant", foreground: "79c0ff" },
      { token: "tag", foreground: "7ee787" },
      { token: "attribute.name", foreground: "79c0ff" },
      { token: "attribute.value", foreground: "a5d6ff" },
      { token: "delimiter", foreground: "8b949e" },
      { token: "operator", foreground: "ff7b72" },
    ],
    colors: {
      "editor.background": "#0c0e12",
      "editor.foreground": "#c9d1d9",
      "editorLineNumber.foreground": "#484f58",
      "editorLineNumber.activeForeground": "#8b949e",
      "editor.lineHighlightBackground": "#ffffff08",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#3392ff44",
      "editor.inactiveSelectionBackground": "#3392ff22",
      "editorCursor.foreground": "#c9d1d9",
      "editorIndentGuide.background": "#ffffff0d",
      "editorIndentGuide.activeBackground": "#ffffff1f",
      "editorBracketMatch.background": "#3392ff33",
      "editorBracketMatch.border": "#3392ff66",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff22",
      "editorWidget.background": "#0c0e12",
      "editorWidget.border": "#ffffff14",
    },
  })
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
      <div className={cn("min-h-0 flex-1")}>
        <Editor
          height="100%"
          path={path}
          language={monacoLanguage}
          value={value}
          theme="sira-dark"
          beforeMount={handleBeforeMount}
          onChange={handleChange}
          onMount={handleMount}
          options={{
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            fontSize: 13,
            lineHeight: 21,
            letterSpacing: 0.2,
            fontLigatures: true,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            renderLineHighlight: "line",
            smoothScrolling: true,
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
            roundedSelection: true,
            // Professional, readable surface: dimmed line-number gutter +
            // bracket-pair colorization + breathing-room padding. Folding
            // column stays off to keep the gutter minimal.
            lineNumbers: "on",
            lineNumbersMinChars: 3,
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 12,
            padding: { top: 14, bottom: 14 },
            bracketPairColorization: { enabled: true },
            guides: { indentation: true, bracketPairs: false },
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
