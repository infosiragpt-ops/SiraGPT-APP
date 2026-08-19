// codex/workspace-tabs — pure state model for the mobile bottom tab bar
// (feature 13): Preview · Agent · Web · Conexiones · Checklist · Archivos. The
// active tab + unseen-event badge live here so switching tabs never unmounts
// the live run (the SSE stream lives in the hook, not a tab). No React; testable.

export type CodexTabId = 'preview' | 'agent' | 'web' | 'connections' | 'checklist' | 'files'

export const TAB_ORDER: CodexTabId[] = ['preview', 'agent', 'web', 'connections', 'checklist', 'files']
export const DEFAULT_TAB: CodexTabId = 'agent'

export interface TabsState {
  active: CodexTabId
  agentUnseen: number // events arrived while not on the Agent tab
  previewError: boolean
}

export function initialTabsState(active: CodexTabId = DEFAULT_TAB): TabsState {
  return { active, agentUnseen: 0, previewError: false }
}

export function isTab(value: unknown): value is CodexTabId {
  return typeof value === 'string' && (TAB_ORDER as string[]).includes(value)
}

export type TabsAction =
  | { type: 'select'; tab: CodexTabId }
  | { type: 'agent_event' } // a run event arrived
  | { type: 'preview_error'; value: boolean }

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'select':
      // Selecting Agent clears its unseen badge.
      return { ...state, active: action.tab, agentUnseen: action.tab === 'agent' ? 0 : state.agentUnseen }
    case 'agent_event':
      // Only accrue the badge when the user is looking elsewhere.
      return state.active === 'agent' ? state : { ...state, agentUnseen: state.agentUnseen + 1 }
    case 'preview_error':
      return { ...state, previewError: action.value }
    default:
      return state
  }
}
