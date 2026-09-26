import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExcelConnector, type ExcelConnectorRef } from '@/components/ExcelConnector'

const state = vi.hoisted(() => ({
  chat: {} as any, save: vi.fn(), exportJson: vi.fn(), insertChart: vi.fn(), action: null as null | (() => void),
}))
vi.mock('@/lib/api', () => ({ apiClient: { saveOfficeDraft: (...args: any[]) => state.save(...args) } }))
vi.mock('@/lib/chat-context-integrated', () => ({ useChat: () => ({ currentChat: state.chat, setCurrentChat: (update: any) => { state.chat = update(state.chat) } }) }))
vi.mock('@/components/ExcelRibbon', () => ({ ExcelRibbon: () => null }))
vi.mock('@syncfusion/ej2-base', () => ({ registerLicense: vi.fn() }))
vi.mock('@syncfusion/ej2-spreadsheet', () => ({ SpreadsheetChart: () => null }))
vi.mock('@syncfusion/ej2-react-spreadsheet', async () => {
  const React = await import('react')
  const empty = () => null
  return {
    SpreadsheetComponent: React.forwardRef(function Spreadsheet({ actionComplete }: any, ref) {
      state.action = actionComplete
      React.useImperativeHandle(ref, () => ({
        sheets: [{ name: 'Ventas', usedRange: { rowIndex: 1 } }], activeSheetIndex: 0, dataBind: () => {},
        insertChart: (...args: any[]) => state.insertChart(...args),
        saveAsJson: (...args: any[]) => state.exportJson(...args),
        // Programmatic loading must not become a manual edit, even if a vendor event fires.
        openFromJson: () => actionComplete(),
      }))
      return null
    }),
    SheetsDirective: empty, SheetDirective: empty, Inject: empty, Ribbon: empty, FormulaBar: empty,
    SheetTabs: empty, Selection: empty, Edit: empty, Clipboard: empty, Open: empty, Save: empty,
    ContextMenu: empty, NumberFormat: empty, Resize: empty, UndoRedo: empty, KeyboardNavigation: empty,
    Sort: empty, Filter: empty, DataValidation: empty, ConditionalFormatting: empty, ProtectSheet: empty,
  }
})

describe('Excel native draft persistence', () => {
  const workbook = { sheets: [{ name: 'Ventas', rows: [{ cells: [{ formula: '=SUM(B1:B3)', value: 6 }] }] }] }
  beforeEach(() => {
    state.chat = { id: 'excel-chat', excelContent: workbook }
    state.save.mockReset().mockResolvedValue({ saved: true })
    state.insertChart.mockReset()
    state.exportJson.mockReset().mockResolvedValue({ jsonObject: { Workbook: { sheets: [] } } })
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('can close before hydration without overwriting the saved workbook with the initial empty sheet', async () => {
    const close = vi.fn()
    render(<ExcelConnector onClose={close} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cerrar', exact: true })) })
    expect(state.exportJson).not.toHaveBeenCalled()
    expect(state.save).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('ignores programmatic loads and events during AI generation', async () => {
    const ref = React.createRef<ExcelConnectorRef>()
    const view = render(<ExcelConnector ref={ref} onClose={() => {}} />)
    await act(async () => { ref.current!.loadWorkbook(workbook) })
    expect(state.exportJson).not.toHaveBeenCalled()
    view.rerender(<ExcelConnector ref={ref} onClose={() => {}} isGeneratingExternal />)
    await act(async () => { state.action!() })
    expect(state.exportJson).not.toHaveBeenCalled()
    expect(state.save).not.toHaveBeenCalled()
  })

  it('serializes snapshots and saves manual cells with formulas before closing', async () => {
    const ref = React.createRef<ExcelConnectorRef>()
    const close = vi.fn()
    render(<ExcelConnector ref={ref} onClose={close} />)
    act(() => { ref.current!.loadWorkbook(workbook) })
    let finishSnapshot!: (result: unknown) => void
    state.exportJson.mockImplementationOnce(() => new Promise((resolve) => { finishSnapshot = resolve }))
    const edited = { sheets: [{ name: 'Ventas', rows: [{ cells: [{ formula: '=SUM(B1:B4)', value: 10 }] }] }] }
    state.exportJson.mockResolvedValue({ jsonObject: { Workbook: edited } })
    act(() => { state.action!(); state.action!() })
    expect(state.exportJson).toHaveBeenCalledExactlyOnceWith({ onlyValues: false })
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar', exact: true }))
    expect(close).not.toHaveBeenCalled()
    await act(async () => { finishSnapshot({ jsonObject: { Workbook: workbook } }) })
    expect(state.save).toHaveBeenCalledExactlyOnceWith('excel-chat', 'excel', edited, workbook)
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps saving and closing unavailable until delayed charts and manual changes are in the snapshot', async () => {
    vi.useFakeTimers()
    const ref = React.createRef<ExcelConnectorRef>()
    const close = vi.fn()
    render(<ExcelConnector ref={ref} onClose={close} />)
    act(() => { ref.current!.loadWorkbook(workbook, [{ type: 'insertChart', range: 'Ventas!A1:B3' }]) })
    expect(screen.getByRole('button', { name: 'Guardar hoja de cálculo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cerrar', exact: true })).toBeDisabled()
    act(() => { state.action!() })
    expect(state.exportJson).not.toHaveBeenCalled()
    const withChart = { sheets: [{ name: 'Ventas', rows: [{ cells: [{ formula: '=SUM(B1:B4)', chart: [{ type: 'Column' }] }] }] }] }
    state.exportJson.mockResolvedValue({ jsonObject: { Workbook: withChart } })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(state.insertChart).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Cerrar', exact: true })).toBeEnabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cerrar', exact: true })) })
    expect(state.save).toHaveBeenCalledExactlyOnceWith('excel-chat', 'excel', withChart, workbook)
    expect(close).toHaveBeenCalledOnce()
  })
})
