"use client"

/**
 * TiptapEditor — the reusable editor surface.
 *
 * Props:
 *   initialMarkdown — document content on first mount.
 *   onChange(md)    — called every keystroke (debounced upstream).
 *   placeholder     — shown when empty.
 *   editable        — default true; set to false for read-only
 *                     previews (the Marco Teórico "Open in editor"
 *                     flow might want a pre-view read state).
 *
 * The component is intentionally self-contained: extensions, round-
 * trip helpers, and toolbar live here so a future "also use this
 * editor for chat composer" swap doesn't fork the config.
 *
 * We include the low-level StarterKit (p, headings, bold/italic,
 * lists, blockquote, code-block, hr, history) plus explicit
 * extensions for Link / Placeholder / Typography / Table /
 * TaskList / TaskItem / Image / CharacterCount / CodeBlockLowlight
 * for syntax highlighting.
 */

import * as React from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Placeholder from "@tiptap/extension-placeholder"
import Link from "@tiptap/extension-link"
import Image from "@tiptap/extension-image"
import Typography from "@tiptap/extension-typography"
import CharacterCount from "@tiptap/extension-character-count"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
// Tiptap v3 ships a TableKit bundle that wires Table + Row + Header
// + Cell in one extension; `@tiptap/extension-table` no longer has
// a default export, only named. Using the kit keeps the editor
// config short and matches the v3 recommended import.
import { TableKit } from "@tiptap/extension-table"

import { EditorToolbar } from "./toolbar"
import { mdToHtml, htmlToMd } from "@/lib/markdown-html"
import { cn } from "@/lib/utils"

// Note on code-block highlighting: keep the editor on StarterKit's
// plain CodeBlock so the document editor does not pull an additional
// grammar bundle. Chat and viewer surfaces use the shared Shiki
// pipeline instead.

interface Props {
  initialMarkdown?: string
  onChange?: (markdown: string, chars: number, words: number) => void
  placeholder?: string
  editable?: boolean
  className?: string
}

export function TiptapEditor({
  initialMarkdown = "",
  onChange,
  placeholder = "Empieza a escribir… o presiona ‘/’ para insertar",
  editable = true,
  className,
}: Props) {
  // Ref so the onUpdate callback captures the latest prop without
  // triggering useEditor reinits.
  const onChangeRef = React.useRef(onChange)
  React.useEffect(() => { onChangeRef.current = onChange }, [onChange])

  const editor = useEditor({
    editable,
    immediatelyRender: false, // SSR safety — Next 14 hydration friendly
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,     // editor: cmd+click follows link
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      }),
      Image.configure({ allowBase64: false }),
      Typography, // smart quotes, ellipses, em-dashes
      CharacterCount,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
    ],
    content: initialMarkdown ? mdToHtml(initialMarkdown) : "",
    onUpdate({ editor }) {
      const md = htmlToMd(editor.getHTML())
      const chars = editor.storage.characterCount?.characters?.() ?? 0
      const words = editor.storage.characterCount?.words?.() ?? 0
      onChangeRef.current?.(md, chars, words)
    },
  })

  // When the initialMarkdown prop changes AFTER mount (e.g., the
  // parent loaded a different document without unmounting us),
  // reflect the new content. Guarded so typing doesn't trigger a
  // re-set from our own emit.
  const prevInitial = React.useRef(initialMarkdown)
  React.useEffect(() => {
    if (!editor) return
    if (prevInitial.current === initialMarkdown) return
    prevInitial.current = initialMarkdown
    const current = htmlToMd(editor.getHTML())
    if (current === initialMarkdown) return
    editor.commands.setContent(mdToHtml(initialMarkdown) || "", { emitUpdate: false })
  }, [initialMarkdown, editor])

  React.useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable)
  }, [editable, editor])

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {editable && <EditorToolbar editor={editor} />}
      <div className="flex-1 overflow-y-auto">
        <EditorContent
          editor={editor}
          className={cn(
            // Content styling — matches the prose plugin elsewhere
            // in the app so a Markdown preview and the editor look
            // identical.
            "prose prose-sm md:prose-base dark:prose-invert max-w-none",
            "px-6 md:px-10 py-8",
            "focus:outline-none",
            // Placeholder color: shows when editor is empty.
            "[&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
            "[&_.is-editor-empty:first-child::before]:text-muted-foreground/60",
            "[&_.is-editor-empty:first-child::before]:float-left",
            "[&_.is-editor-empty:first-child::before]:pointer-events-none",
            "[&_.is-editor-empty:first-child::before]:h-0",
            // Code block: use the site's font stack but monospace.
            "[&_pre]:bg-muted [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:text-sm",
            // Task list checkboxes.
            "[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0",
            "[&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:gap-2",
            "[&_ul[data-type=taskList]_li_>_label]:mt-1",
            // Tables: simple borders.
            "[&_table]:border-collapse [&_th]:border [&_td]:border [&_th]:p-2 [&_td]:p-2",
            "[&_th]:bg-muted/40 [&_th]:font-semibold [&_th]:text-left",
          )}
        />
      </div>
    </div>
  )
}

/**
 * Small read-only helper for rendering a markdown snapshot with the
 * same extensions the editor uses. Useful for previews that want
 * task checkboxes / tables / code highlight without the toolbar.
 */
export function TiptapViewer({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <TiptapEditor
      initialMarkdown={markdown}
      editable={false}
      className={className}
    />
  )
}
