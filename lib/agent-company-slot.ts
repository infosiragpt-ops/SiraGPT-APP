/**
 * Agent company panel dock slot — lets `/code`'s AgentCompanyPanel render
 * into the AppSidebar APPS rail (beside the Chats/Code toggle) via portal.
 *
 * The slot element is registered by AppSidebar when Code mode is open on
 * desktop; the panel subscribes and portals into it. No React context
 * coupling between Sidebar and CodeWorkspaceProvider is required.
 */

type SlotListener = (el: HTMLElement | null) => void

let slotElement: HTMLElement | null = null
const listeners = new Set<SlotListener>()

export function registerAgentCompanySlot(el: HTMLElement | null): void {
  slotElement = el
  for (const listener of listeners) listener(slotElement)
}

export function getAgentCompanySlot(): HTMLElement | null {
  return slotElement
}

export function subscribeAgentCompanySlot(listener: SlotListener): () => void {
  listeners.add(listener)
  listener(slotElement)
  return () => {
    listeners.delete(listener)
  }
}
