"use client"

import React from "react"
import type { Workbook, Worksheet } from "exceljs"
import { cn } from "@/lib/utils"
import { readXlsxPreview, xlsxCellToText } from "@/lib/xlsx-client"
import { SHEET_PAGE_ROWS, spreadsheetCellStyle, spreadsheetCellText, spreadsheetColumnLabel, spreadsheetDimensions, spreadsheetMergeSpans } from "@/lib/spreadsheet-preview-model"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

export function SpreadsheetPreview({ buffer, visualPreview }: { buffer: ArrayBuffer; visualPreview?: React.ReactNode }) {
  const [hasVisualObjects, setHasVisualObjects] = React.useState(false)
  const [workbook, setWorkbook] = React.useState<Workbook | null>(null)
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    let cancelled = false
    setWorkbook(null); setError(""); setHasVisualObjects(false)
    if (buffer.byteLength > 25 * 1024 * 1024) { setError("Este libro supera 25 MB. Descárgalo para abrirlo completo."); return }
    void readXlsxPreview(buffer).then(({ workbook, hasVisualObjects }) => { if (!cancelled) { setWorkbook(workbook as unknown as Workbook); setHasVisualObjects(hasVisualObjects) } }).catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo leer el libro.") })
    return () => { cancelled = true }
  }, [buffer])
  if (error) return <p role="alert" className="p-6 text-sm text-destructive">{error}</p>
  if (!workbook) return <div role="status" className="flex h-full items-center justify-center gap-2 text-sm"><ThinkingIndicator size="sm" />Leyendo hoja de cálculo…</div>
  return <WorkbookGrid workbook={workbook} visualPreview={hasVisualObjects ? visualPreview || <p role="status" className="p-4 text-sm">La cuadrícula muestra las celdas. Descarga el archivo para ver sus gráficas y objetos completos.</p> : undefined} />
}

export function WorkbookGrid({ workbook, visualPreview }: { workbook: Workbook; visualPreview?: React.ReactNode }) {
  const sheets = workbook.worksheets.filter((sheet) => sheet.state === "visible" || !sheet.state)
  const [active, setActive] = React.useState(sheets[0]?.id)
  const [page, setPage] = React.useState(0)
  const [selected, setSelected] = React.useState("A1")
  const sheet: Worksheet | undefined = sheets.find((value) => value.id === active) || sheets[0]
  if (!sheet) return <p className="p-6 text-sm">El libro no contiene hojas visibles.</p>
  const { rows, columns, totalColumns } = spreadsheetDimensions(sheet)
  const firstRow = page * SHEET_PAGE_ROWS + 1, lastRow = Math.min(rows, firstRow + SHEET_PAGE_ROWS - 1)
  const rowNumbers = Array.from({ length: Math.max(0, lastRow - firstRow + 1) }, (_, i) => firstRow + i)
  const columnNumbers = Array.from({ length: columns }, (_, i) => i + 1)
  const columnWidth = (c: number) => Math.max(35, Math.min(600, (sheet.getColumn(c).width || 12) * 7 + 5))
  const { spans, covered } = spreadsheetMergeSpans(sheet, firstRow, lastRow, columns)
  const cell = sheet.getCell(selected)
  const formula = cell.formula ? `=${cell.formula}` : xlsxCellToText(cell.value)
  return (
    <div data-testid="spreadsheet-preview" className="flex h-full min-h-0 flex-col bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-zinc-200 px-3 text-xs dark:border-zinc-700" aria-label="Contenido de la celda">
        <span className="w-14 shrink-0 text-center font-semibold tabular-nums">{selected}</span><span aria-hidden="true" className="border-l pl-3 italic text-zinc-400">fx</span><span className="truncate" title={formula}>{formula}</span>
      </div>
      {totalColumns > columns && <p role="status" className="px-3 py-1 text-xs">Se muestran {columns} de {totalColumns} columnas. El archivo descargable contiene el libro completo.</p>}
      <div className="min-h-0 flex-1 overflow-auto" key={`${sheet.id}:${page}`}>
        <table aria-label={`Hoja ${sheet.name}`} className="border-separate border-spacing-0 text-[13px]" style={{ width: 44 + columnNumbers.reduce((sum, c) => sum + columnWidth(c), 0), tableLayout: "fixed", fontVariantNumeric: "tabular-nums" }}>
          <colgroup><col style={{ width: 44 }} />{columnNumbers.map((c) => <col key={c} style={{ width: columnWidth(c) }} />)}</colgroup>
          <thead className="sticky top-0 z-20"><tr><th className="sticky left-0 z-30 h-7 border-b border-r border-zinc-300 bg-zinc-100 text-xs dark:border-zinc-700 dark:bg-zinc-800" aria-label="Filas" />{columnNumbers.map((c) => <th key={c} className="h-7 border-b border-r border-zinc-300 bg-zinc-100 px-2 text-center text-xs font-normal dark:border-zinc-700 dark:bg-zinc-800">{spreadsheetColumnLabel(c)}</th>)}</tr></thead>
          <tbody>{rowNumbers.map((r) => <tr key={r} style={{ height: Math.min(300, (sheet.getRow(r).height || 18) * 4 / 3) }}>
            <th scope="row" className="sticky left-0 z-10 min-w-11 border-b border-r border-zinc-300 bg-zinc-100 px-2 text-right text-xs font-normal dark:border-zinc-700 dark:bg-zinc-800">{r}</th>
            {columnNumbers.map((c) => {
              if (covered.has(`${r}:${c}`)) return null
              const value = sheet.getRow(r).getCell(c)
              const address = `${spreadsheetColumnLabel(c)}${r}`
              return <td key={c} {...spans.get(`${r}:${c}`)} tabIndex={0} onFocus={() => setSelected(address)} onClick={() => setSelected(address)} aria-label={`${address}: ${spreadsheetCellText(value)}`} title={value.formula ? `=${value.formula}` : spreadsheetCellText(value)} className={cn("max-w-[600px] border-b border-r border-zinc-200 px-1.5 py-0.5 outline-none dark:border-zinc-700", selected === address && "ring-2 ring-inset ring-emerald-600")} style={spreadsheetCellStyle(value)}>{spreadsheetCellText(value)}</td>
            })}
          </tr>)}</tbody>
        </table>
        {visualPreview && <section aria-label="Gráficas y objetos del libro" className="border-t border-zinc-200 dark:border-zinc-700">{visualPreview}</section>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950">
        <div role="tablist" aria-label="Hojas del libro" className="flex max-w-full gap-1 overflow-x-auto">{sheets.map((value) => <button key={value.id} role="tab" aria-selected={value.id === sheet.id} onClick={() => { setActive(value.id); setPage(0); setSelected("A1") }} className={cn("whitespace-nowrap border-b-2 px-3 py-2 font-medium", value.id === sheet.id ? "border-emerald-600 bg-white text-emerald-700 dark:bg-zinc-800 dark:text-emerald-400" : "border-transparent text-zinc-500")}>{value.name}</button>)}</div>
        <div className="flex items-center gap-2 tabular-nums"><span>{rows} filas · {totalColumns} columnas</span>{rows > SHEET_PAGE_ROWS && <><button disabled={page === 0} onClick={() => setPage((value) => value - 1)} className="rounded border px-2 py-1 disabled:opacity-40" aria-label="Filas anteriores">‹</button><span>{firstRow}–{lastRow}</span><button disabled={lastRow >= rows} onClick={() => setPage((value) => value + 1)} className="rounded border px-2 py-1 disabled:opacity-40" aria-label="Filas siguientes">›</button></>}</div>
      </div>
    </div>
  )
}
