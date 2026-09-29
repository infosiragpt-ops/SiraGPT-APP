"use client"

/**
 * Row selection + copy shared by the four Admin → Logs tabs.
 *
 *   - Checkbox toggles one row, Shift+click selects/clears a range, the
 *     header box selects/clears every loaded row.
 *   - Ctrl/Cmd+C copies the selection in the chosen format (only when the
 *     operator has not highlighted text and is not typing in a field, so the
 *     browser's own copy keeps working); Escape clears the selection.
 *   - The chosen format is remembered per browser.
 *   - Rows that leave the list (filters, live refresh, pagination) leave the
 *     selection, so the count always matches what will be copied.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  copyText,
  DEFAULT_COPY_FORMAT,
  downloadText,
  fileExtensionFor,
  formatRecords,
  hasTextSelection,
  isCopyFormat,
  toggleSelection,
  type CopyFormat,
  type CopyRecord,
} from "./log-copy"

const FORMAT_STORAGE_KEY = "sira:admin-log-copy-format"

export type LogSelectionNoun = { one: string; many: string; feminine?: boolean }

export type UseLogSelectionOptions<T> = {
  rows: T[]
  getId: (row: T) => string
  toRecord: (row: T) => CopyRecord
  /** Per-tab override of a format (e.g. the live log's exact text layout). */
  formatOverride?: Partial<Record<CopyFormat, (rows: T[]) => string>>
  noun: LogSelectionNoun
  filePrefix: string
  /** Disable the Ctrl/Cmd+C / Escape shortcuts (tests, nested dialogs). */
  shortcuts?: boolean
}

function readStoredFormat(): CopyFormat {
  try {
    const v = window.localStorage.getItem(FORMAT_STORAGE_KEY)
    return isCopyFormat(v) ? v : DEFAULT_COPY_FORMAT
  } catch {
    return DEFAULT_COPY_FORMAT
  }
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type
    return type !== "checkbox" && type !== "radio" && type !== "button"
  }
  return tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable === true
}

export function useLogSelection<T>({
  rows,
  getId,
  toRecord,
  formatOverride,
  noun,
  filePrefix,
  shortcuts = true,
}: UseLogSelectionOptions<T>) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [format, setFormatState] = useState<CopyFormat>(DEFAULT_COPY_FORMAT)
  const anchorRef = useRef<string | null>(null)

  useEffect(() => {
    setFormatState(readStoredFormat())
  }, [])

  const setFormat = useCallback((next: CopyFormat) => {
    setFormatState(next)
    try { window.localStorage.setItem(FORMAT_STORAGE_KEY, next) } catch { /* private mode */ }
  }, [])

  const orderedIds = useMemo(() => rows.map(getId), [rows, getId])

  const selectedRows = useMemo(
    () => (selectedIds.size ? rows.filter((r) => selectedIds.has(getId(r))) : []),
    [rows, selectedIds, getId],
  )

  useEffect(() => {
    if (selectedIds.size && selectedIds.size !== selectedRows.length) {
      setSelectedIds(new Set(selectedRows.map(getId)))
    }
  }, [selectedIds, selectedRows, getId])

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds])

  const toggle = useCallback((id: string, range = false) => {
    setSelectedIds((prev) => toggleSelection(orderedIds, prev, id, anchorRef.current, range))
    anchorRef.current = id
  }, [orderedIds])

  const total = rows.length
  const count = selectedRows.length
  const allSelected = total > 0 && count === total
  const someSelected = count > 0 && !allSelected

  const toggleAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(orderedIds))
    anchorRef.current = null
  }, [allSelected, orderedIds])

  const clear = useCallback(() => {
    setSelectedIds(new Set())
    anchorRef.current = null
  }, [])

  const render = useCallback((list: T[], fmt: CopyFormat) => {
    const override = formatOverride?.[fmt]
    return override ? override(list) : formatRecords(list.map(toRecord), fmt)
  }, [formatOverride, toRecord])

  const copyRows = useCallback(async (list: T[], fmt: CopyFormat = format) => {
    if (!list.length) {
      toast.error("No hay nada que copiar")
      return false
    }
    const ok = await copyText(render(list, fmt))
    const o = noun.feminine ? "a" : "o"
    if (ok) toast.success(`${list.length} ${list.length === 1 ? `${noun.one} copiad${o}` : `${noun.many} copiad${o}s`}`)
    else toast.error("No se pudo copiar. Usa «Exportar» para descargarlo.")
    return ok
  }, [format, render, noun])

  const exportRows = useCallback((list: T[], fmt: CopyFormat = format, suffix = "") => {
    if (!list.length) return
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const mime = fmt === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8"
    downloadText(render(list, fmt), `${filePrefix}${suffix}-${stamp}.${fileExtensionFor(fmt)}`, mime)
  }, [format, render, filePrefix])

  const copySelected = useCallback((fmt?: CopyFormat) => copyRows(selectedRows, fmt), [copyRows, selectedRows])
  const exportSelected = useCallback((fmt?: CopyFormat) => exportRows(selectedRows, fmt, "-seleccion"), [exportRows, selectedRows])

  const copySelectedRef = useRef(copySelected)
  copySelectedRef.current = copySelected
  const countRef = useRef(count)
  countRef.current = count

  useEffect(() => {
    if (!shortcuts || typeof document === "undefined") return
    const onKey = (e: KeyboardEvent) => {
      if (!countRef.current) return
      if (isTypingTarget(document.activeElement)) return
      if (document.querySelector("[role='dialog'][data-state='open']")) return
      if (e.key === "Escape") {
        clear()
        return
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c") {
        if (hasTextSelection()) return
        e.preventDefault()
        void copySelectedRef.current()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [shortcuts, clear])

  return {
    selectedIds,
    selectedRows,
    count,
    total,
    allSelected,
    someSelected,
    isSelected,
    toggle,
    toggleAll,
    clear,
    format,
    setFormat,
    copyRows,
    exportRows,
    copySelected,
    exportSelected,
    render,
  }
}

export type LogSelection<T> = ReturnType<typeof useLogSelection<T>>
