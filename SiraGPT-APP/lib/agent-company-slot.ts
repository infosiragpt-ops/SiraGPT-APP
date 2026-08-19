/**
 * Shared dock slot used to render the desktop agent-company navigation inside
 * the AppSidebar while keeping it connected to the /code workspace context.
 */

type SlotListener = (element: HTMLElement | null) => void

let slotElement: HTMLElement | null = null
const listeners = new Set<SlotListener>()

export function registerAgentCompanySlot(element: HTMLElement | null): void {
  slotElement = element
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
