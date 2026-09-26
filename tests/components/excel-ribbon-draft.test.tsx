import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExcelRibbon } from '@/components/ExcelRibbon'

describe('Excel ribbon draft notifications', () => {
  afterEach(cleanup)

  it('notifies manual cell formatting but not tab navigation or copying', () => {
    const spreadsheet = {
      getActiveSheet: () => ({ selectedRange: 'B2:C3' }),
      cellFormat: vi.fn(), dataBind: vi.fn(), copy: vi.fn(),
    }
    const changed = vi.fn()
    render(<ExcelRibbon spreadsheetRef={{ current: spreadsheet } as any} onWorkbookChange={changed} />)
    fireEvent.click(screen.getByRole('button', { name: 'View', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Home', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy', exact: true }))
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Align Left', exact: true }))
    expect(spreadsheet.cellFormat).toHaveBeenCalledExactlyOnceWith({ textAlign: 'left' }, 'B2:C3')
    expect(changed).toHaveBeenCalledOnce()
  })
})
