import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import * as React from 'react'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key, useLocale: () => 'es' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/agentes', useSearchParams: () => new URLSearchParams() }))

import MessageComponent from '@/components/message-component'
import type { MediaDeliveryProgress } from '@/hooks/use-media-delivery-progress'

const message = { id: 'handoff', role: 'ASSISTANT', content: 'El trabajo está guardado.', files: null }
const progress = (label: string, percent: number | null = null): MediaDeliveryProgress => ({ pending: true, stage: 'extracting', label, percent })
const view = (cloudProgress?: MediaDeliveryProgress, isStreaming = false) => (
  <MessageComponent message={message} user={null} onRegenerate={() => {}} updateMessageInChat={() => {}}
    cloudProgress={cloudProgress} isStreaming={isStreaming} />
)

describe('persisted cloud work in a settled message', () => {
  it('shows progress after reloading a settled acknowledgement and retains the answer', () => {
    const { container, unmount } = render(view(progress('Transcribiendo en la nube · 67 %', 67)))
    expect(screen.getByText('El trabajo está guardado.')).toBeTruthy()
    expect(container.querySelector('[data-cloud-task-status]')?.textContent).toBe('Transcribiendo en la nube · 67 %')
    expect(container.querySelector('[data-cloud-task-status] [data-pensando-bars]')).toBeTruthy()
    unmount()
  })

  it('updates the same message when only server progress changes, then removes it on delivery', () => {
    const { container, rerender, unmount } = render(view(progress('Transcribiendo en la nube · 33 %', 33)))
    const answer = screen.getByText('El trabajo está guardado.')
    rerender(view(progress('Transcribiendo en la nube · 67 %', 67)))
    expect(container.querySelector('[data-cloud-task-status]')?.textContent).toBe('Transcribiendo en la nube · 67 %')
    expect(screen.getByText('El trabajo está guardado.')).toBe(answer)
    rerender(view())
    expect(container.querySelector('[data-cloud-task-status]')).toBeNull()
    expect(screen.getByText('El trabajo está guardado.')).toBe(answer)
    unmount()
  })

  it('does not duplicate the active turn indicator before the handoff settles', () => {
    const { container, rerender, unmount } = render(view(progress('Recuperando estado del trabajo…'), true))
    expect(container.querySelector('[data-cloud-task-status]')).toBeNull()
    rerender(view(progress('Recuperando estado del trabajo…')))
    expect(container.querySelector('[data-cloud-task-status]')).toBeTruthy()
    unmount()
  })
})
