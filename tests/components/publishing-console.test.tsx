import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { PublishingConsole } from '@/components/code/publishing-console'
import type { PublishingConsoleState } from '@/lib/publishing-console-types'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}))

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_OPEN = window.open

const state: PublishingConsoleState = {
  appName: 'siragpt',
  ownerName: 'kk',
  statusLabel: 'published',
  visibility: 'Public',
  seoRating: 'HEALTHY',
  productionUrl: 'https://siragpt.com',
  replitUrl: 'https://siragpt.replit.app',
  customDomainUrl: 'https://siragpt.com',
  referralLink: 'https://replit.com/refer/infosiragpt',
  geography: 'North America',
  deploymentType: 'Reserved VM',
  deploymentTypeDetail: 'Dedicated 2 vCPU / 8 GiB RAM',
  databaseLabel: 'Production database connected',
  healthStatus: 'healthy',
  lastPublishedAgo: 'about 4 hours ago',
  deploymentId: '63298d0b',
  domains: [
    {
      host: 'siragpt.replit.app',
      url: 'https://siragpt.replit.app',
      registeredWith: 'N/A',
      verified: true,
      manageable: false,
    },
    {
      host: 'siragpt.com',
      url: 'https://siragpt.com',
      registeredWith: 'GoDaddy.com, LLC',
      verified: true,
      warning: true,
      manageable: true,
    },
  ],
  timeline: [{ id: '438d7595', label: '438d7595', publishedAgo: 'kk published 10 days ago' }],
  logs: [
    {
      id: '1',
      time: '2026-06-22 18:41:07.90',
      deployment: '63298d0b',
      source: 'User',
      log: '[backend] Health check passed',
      severity: 'info',
    },
    {
      id: '2',
      time: '2026-06-22 18:41:08.00',
      deployment: '63298d0b',
      source: 'User',
      log: '[backend] Error: P3018',
      severity: 'error',
    },
  ],
  madeWithReplitBadge: false,
  apiConfigured: true,
  generatedAt: '2026-06-22T22:41:00.000Z',
}

describe('PublishingConsole', () => {
  beforeEach(() => {
    window.open = vi.fn() as any
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
    window.open = ORIGINAL_OPEN
    vi.restoreAllMocks()
  })

  it('renders Replit-style tabs and switches between them', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => state,
    }) as any

    render(<PublishingConsole open onOpenChange={vi.fn()} />)

    expect(await screen.findByRole('tab', { name: /overview/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /republish/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /logs/i }))
    expect(screen.getByPlaceholderText('Search')).toBeInTheDocument()
    expect(screen.getByText('[backend] Error: P3018')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /domains/i }))
    expect(screen.getByText('siragpt.replit.app')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /connect your own domain/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /manage/i }))
    expect(screen.getByText('Manage published app')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('calls the publishing action API when republishing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => state,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, message: 'Republish started', state }),
      })
    globalThis.fetch = fetchMock as any

    render(<PublishingConsole open onOpenChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /republish/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toBe('/publishing/state')
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'republish' }),
    }))
  })
})
