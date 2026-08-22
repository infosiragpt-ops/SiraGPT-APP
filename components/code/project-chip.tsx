"use client"

/**
 * ProjectChip — hidden. Company name already lives in the SiraGPT sidebar
 * switcher, so the folder + "Empresa" + chevron chip is redundant chrome.
 * Full implementation is in project-chip.tsx.bak-drop-dup-header-20260815.
 */

export function ProjectChip(_props: { onOpenCode?: () => void; onOpenInvite?: () => void }) {
  return <span hidden data-drop-dup-header="20260815" data-testid="project-chip-hidden" />
}
