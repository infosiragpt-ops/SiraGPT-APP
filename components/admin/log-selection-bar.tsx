"use client"

/**
 * Selection toolbar + checkboxes shared by the four Admin → Logs tabs.
 * The state lives in `useLogSelection`; this file only renders it.
 */

import { useEffect, useRef } from "react"
import { Copy, Download, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { COPY_FORMATS, type CopyFormat } from "@/lib/admin/log-copy"
import type { LogSelectionNoun } from "@/lib/admin/use-log-selection"
import { cn } from "@/lib/utils"

const CHECKBOX_CLASS =
  "h-3.5 w-3.5 shrink-0 cursor-pointer rounded-[3px] accent-foreground disabled:cursor-default"

type RowCheckboxProps = {
  checked: boolean
  onToggle: (range: boolean) => void
  label: string
  testId?: string
  className?: string
}

/** Native checkbox so Shift+click (range) reaches the handler; never opens the row. */
export function RowCheckbox({ checked, onToggle, label, testId, className }: RowCheckboxProps) {
  return (
    <span className={cn("flex items-center", className)} onClick={(e) => e.stopPropagation()}>
      <input
        type="checkbox"
        className={CHECKBOX_CLASS}
        checked={checked}
        onChange={() => undefined}
        onClick={(e) => { e.stopPropagation(); onToggle(e.shiftKey) }}
        onKeyDown={(e) => { if (e.key === " ") e.stopPropagation() }}
        aria-label={label}
        data-testid={testId}
      />
    </span>
  )
}

type HeaderCheckboxProps = {
  allSelected: boolean
  someSelected: boolean
  disabled?: boolean
  onToggle: () => void
  label?: string
  testId?: string
}

export function HeaderCheckbox({ allSelected, someSelected, disabled, onToggle, label = "Seleccionar todo lo cargado", testId }: HeaderCheckboxProps) {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected
  }, [someSelected])
  return (
    <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        type="checkbox"
        className={CHECKBOX_CLASS}
        checked={allSelected}
        onChange={onToggle}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
      />
    </span>
  )
}

type LogSelectionBarProps = {
  count: number
  noun: LogSelectionNoun
  format: CopyFormat
  onFormatChange: (format: CopyFormat) => void
  onCopy: () => void
  onExport: () => void
  onClear: () => void
  testIdPrefix: string
  className?: string
}

export function LogSelectionBar({
  count,
  noun,
  format,
  onFormatChange,
  onCopy,
  onExport,
  onClear,
  testIdPrefix,
  className,
}: LogSelectionBarProps) {
  if (count <= 0) return null
  const current = COPY_FORMATS.find((f) => f.value === format) || COPY_FORMATS[0]
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-foreground/15 bg-foreground/[0.03] px-3 py-1.5 text-xs",
        className,
      )}
      data-testid={`${testIdPrefix}-selection`}
      role="status"
    >
      <span className="font-medium tabular-nums">
        {count} {count === 1 ? `${noun.one} seleccionad${noun.feminine ? "a" : "o"}` : `${noun.many} seleccionad${noun.feminine ? "a" : "o"}s`}
      </span>
      <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />
      <Button size="sm" className="h-7 text-[11px]" onClick={onCopy} data-testid={`${testIdPrefix}-copy-selected`}>
        <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar
      </Button>
      <Select value={format} onValueChange={(v) => onFormatChange(v as CopyFormat)}>
        <SelectTrigger className="h-7 w-[132px] text-[11px]" aria-label="Formato al copiar" data-testid={`${testIdPrefix}-copy-format`}>
          <SelectValue>{current.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {COPY_FORMATS.map((f) => (
            <SelectItem key={f.value} value={f.value} className="text-xs">
              <span className="font-medium">{f.label}</span>
              <span className="ml-2 text-muted-foreground">{f.hint}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onExport} data-testid={`${testIdPrefix}-export-selected`}>
        <Download className="mr-1.5 h-3.5 w-3.5" /> Exportar
      </Button>
      <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={onClear} data-testid={`${testIdPrefix}-clear-selection`}>
        <X className="mr-1.5 h-3.5 w-3.5" /> Quitar selección
      </Button>
      <span className="ml-auto hidden text-muted-foreground lg:inline">
        Mayús + clic: rango · <kbd className="font-mono">Ctrl/⌘ C</kbd>: copiar · <kbd className="font-mono">Esc</kbd>: quitar
      </span>
    </div>
  )
}
