"use client"

/**
 * Editor toolbar — compact formatting bar that sits above the
 * Tiptap editor. Deliberately small: only the formats a thesis
 * writer actually needs (headings, bold, italic, code, lists, link,
 * table). Anything further lives in the bubble menu on selection.
 *
 * Each button calls the editor chain in the shape Tiptap v3 wants:
 *   editor.chain().focus().<command>().run()
 * Focus() is important — without it the first click steals focus
 * from the editor and the selection is lost.
 */

import * as React from "react"
import type { Editor } from "@tiptap/react"
import {
  Bold, Italic, Code, Strikethrough, List, ListOrdered,
  Heading1, Heading2, Heading3, Quote, Minus, Link2,
  CheckSquare, Table as TableIcon, Undo2, Redo2,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface Props {
  editor: Editor | null
}

export function EditorToolbar({ editor }: Props) {
  // Small wrapper so the "is-active" state renders without copy-
  // pasting `editor.isActive(...)` on every button.
  const Btn = ({
    onClick, active, disabled, title, children,
  }: {
    onClick: () => void
    active?: boolean
    disabled?: boolean
    title: string
    children: React.ReactNode
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
        "hover:bg-muted/60 disabled:opacity-40 disabled:pointer-events-none",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </button>
  )

  const setLink = React.useCallback(() => {
    if (!editor) return
    const prev = editor.getAttributes("link").href as string | undefined
    const url = window.prompt("URL", prev || "https://")
    if (url === null) return // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
  }, [editor])

  const insertTable = React.useCallback(() => {
    if (!editor) return
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  }, [editor])

  if (!editor) return null

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b border-border/60 bg-background/95 backdrop-blur px-2 py-1.5">
      <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })} title="Título 1">
        <Heading1 className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} title="Título 2">
        <Heading2 className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} title="Título 3">
        <Heading3 className="h-4 w-4" />
      </Btn>
      <span className="mx-1 h-5 w-px bg-border" />
      <Btn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="Negrita (⌘B)">
        <Bold className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="Itálica (⌘I)">
        <Italic className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")} title="Tachado">
        <Strikethrough className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive("code")} title="Código inline">
        <Code className="h-4 w-4" />
      </Btn>
      <span className="mx-1 h-5 w-px bg-border" />
      <Btn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Lista con viñetas">
        <List className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Lista numerada">
        <ListOrdered className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive("taskList")} title="Lista de tareas">
        <CheckSquare className="h-4 w-4" />
      </Btn>
      <span className="mx-1 h-5 w-px bg-border" />
      <Btn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} title="Cita">
        <Quote className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Separador">
        <Minus className="h-4 w-4" />
      </Btn>
      <Btn onClick={setLink} active={editor.isActive("link")} title="Enlace (⌘K)">
        <Link2 className="h-4 w-4" />
      </Btn>
      <Btn onClick={insertTable} title="Tabla">
        <TableIcon className="h-4 w-4" />
      </Btn>
      <span className="mx-1 h-5 w-px bg-border" />
      <Btn onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Deshacer">
        <Undo2 className="h-4 w-4" />
      </Btn>
      <Btn onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Rehacer">
        <Redo2 className="h-4 w-4" />
      </Btn>
    </div>
  )
}
