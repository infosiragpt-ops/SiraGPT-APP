import { describe, it, expect, vi } from 'vitest'
import { renderWithIntl as render, screen, fireEvent } from '../lib/codex/intl-test-utils'
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

  it('renders REAL per-task status from update_plan (plan_updated) while the run is active', () => {
    const state = reduceEvents([
      { seq: 1, type: 'plan_proposed', data: { architecture: 'x', pages: [], components: [], tasks: [{ id: 't1', title: 'Crear hero' }, { id: 't2', title: 'Agregar nav' }] } },
      { seq: 2, type: 'plan_updated', data: { tasks: [{ id: 't1', title: 'Crear hero', status: 'completed' }, { id: 't2', title: 'Agregar nav', status: 'in_progress' }] } },
    ])
    // Run is still running: with real progress the first task is DONE (line-through)
    // even though the coarse fallback would have shown only task 0 in progress.
    render(<ChecklistTab state={state} runStatus="running" />)
    const done = screen.getByText('Crear hero')
    expect(done.className).toMatch(/line-through/)
    const inProgress = screen.getByText('Agregar nav')
    expect(inProgress.className).not.toMatch(/line-through/)
  })

  it('degrades to the coarse fallback when no plan_updated has arrived', () => {
    const state = reduceEvents([
      { seq: 1, type: 'plan_proposed', data: { architecture: 'x', pages: [], components: [], tasks: [{ id: 't1', title: 'Crear hero' }, { id: 't2', title: 'Agregar nav' }] } },
    ])
    // No plan_updated → run done marks every task done (legacy behaviour).
    render(<ChecklistTab state={state} runStatus="done" />)
    expect(screen.getByText('Crear hero').className).toMatch(/line-through/)
    expect(screen.getByText('Agregar nav').className).toMatch(/line-through/)
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
