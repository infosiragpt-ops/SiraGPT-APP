import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BottomTabBar } from '@/components/codex/bottom-tab-bar'
import { ChecklistTab } from '@/components/codex/checklist-tab'
import { WebTab } from '@/components/codex/web-tab'
import { initialTabsState } from '@/lib/codex/workspace-tabs'
import { reduceEvents } from '@/lib/codex/timeline-reducer'

describe('BottomTabBar', () => {
  it('renders the 6 tabs and reports selection', () => {
    const onSelect = vi.fn()
    render(<BottomTabBar state={initialTabsState()} onSelect={onSelect} />)
    for (const label of ['Preview', 'Agent', 'Web', 'Conexiones', 'Checklist', 'Archivos']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    fireEvent.click(screen.getByText('Web'))
    expect(onSelect).toHaveBeenCalledWith('web')
  })

  it('shows the Agent unseen-events badge', () => {
    render(<BottomTabBar state={{ active: 'preview', agentUnseen: 3, previewError: false }} onSelect={() => {}} />)
    expect(screen.getByText('3')).toBeTruthy()
  })
})

describe('ChecklistTab', () => {
  it('renders the approved plan tasks; all done when the run is done', () => {
    const state = reduceEvents([
      { seq: 1, type: 'plan_proposed', data: { architecture: 'x', pages: [], components: [], tasks: [{ title: 'Crear hero' }, { title: 'Agregar nav' }] } },
    ])
    render(<ChecklistTab state={state} runStatus="done" />)
    expect(screen.getByText('Crear hero')).toBeTruthy()
    expect(screen.getByText('Agregar nav')).toBeTruthy()
  })

  it('shows an empty state with no plan', () => {
    render(<ChecklistTab state={reduceEvents([])} runStatus={null} />)
    expect(screen.getByText(/Aún no hay un plan/)).toBeTruthy()
  })
})

describe('WebTab', () => {
  it('shows a placeholder without a URL and an iframe with one', () => {
    const { rerender } = render(<WebTab url={null} />)
    expect(screen.getByText(/preview aún no está disponible/i)).toBeTruthy()
    rerender(<WebTab url="http://localhost:5173" />)
    expect(screen.getByTitle('Preview')).toBeTruthy()
  })
})
