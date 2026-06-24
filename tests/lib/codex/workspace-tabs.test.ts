import { describe, it, expect } from 'vitest'
import { initialTabsState, tabsReducer, isTab, TAB_ORDER, DEFAULT_TAB } from '@/lib/codex/workspace-tabs'

describe('workspace-tabs', () => {
  it('has six tabs with Agent as the default', () => {
    expect(TAB_ORDER).toEqual(['preview', 'agent', 'web', 'connections', 'checklist', 'files'])
    expect(DEFAULT_TAB).toBe('agent')
    expect(initialTabsState().active).toBe('agent')
  })

  it('isTab validates ids', () => {
    expect(isTab('files')).toBe(true)
    expect(isTab('nope')).toBe(false)
  })

  it('accrues an Agent badge only while on another tab', () => {
    let s = initialTabsState('preview')
    s = tabsReducer(s, { type: 'agent_event' })
    s = tabsReducer(s, { type: 'agent_event' })
    expect(s.agentUnseen).toBe(2)
    // On the Agent tab, events do not accrue a badge.
    s = tabsReducer(s, { type: 'select', tab: 'agent' })
    expect(s.agentUnseen).toBe(0)
    s = tabsReducer(s, { type: 'agent_event' })
    expect(s.agentUnseen).toBe(0)
  })

  it('selecting Agent clears the unseen badge', () => {
    let s = initialTabsState('files')
    s = tabsReducer(s, { type: 'agent_event' })
    expect(s.agentUnseen).toBe(1)
    s = tabsReducer(s, { type: 'select', tab: 'agent' })
    expect(s.agentUnseen).toBe(0)
    expect(s.active).toBe('agent')
  })

  it('tracks a preview error flag', () => {
    let s = initialTabsState()
    s = tabsReducer(s, { type: 'preview_error', value: true })
    expect(s.previewError).toBe(true)
    s = tabsReducer(s, { type: 'preview_error', value: false })
    expect(s.previewError).toBe(false)
  })
})
