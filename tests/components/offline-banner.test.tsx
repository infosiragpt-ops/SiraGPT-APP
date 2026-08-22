import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OfflineBanner } from '@/components/offline-banner'
import * as pendingMessages from '@/lib/pending-messages'

// Mock lucide-react icons so markup assertions stay simple.
vi.mock('lucide-react', () => ({
  WifiOff: (props: any) => <svg data-testid="wifi-off" {...props} />,
  RefreshCw: (props: any) => <svg data-testid="refresh-cw" {...props} />,
}))

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: online })
}

describe('OfflineBanner', () => {
  const originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine')

  beforeEach(() => {
    setOnline(true)
    vi.spyOn(pendingMessages, 'getAll').mockReturnValue([])
    vi.spyOn(pendingMessages, 'retryAll').mockResolvedValue({ retried: 0, stillPending: 0 })
  })

  afterEach(() => {
    if (originalOnLine) {
      Object.defineProperty(window.navigator, 'onLine', originalOnLine)
    }
    vi.restoreAllMocks()
  })

  it('renders nothing while online with no recoverable messages', () => {
    const { container } = render(<OfflineBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the offline banner when the browser fires "offline"', async () => {
    render(<OfflineBanner />)
    act(() => {
      setOnline(false)
      window.dispatchEvent(new Event('offline'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('offline-banner')).toBeInTheDocument()
    })
    expect(screen.getByText(/Sin conexión/)).toBeInTheDocument()
  })

  it('hides the banner and offers Reintentar when back online with queued messages', async () => {
    vi.mocked(pendingMessages.getAll).mockReturnValue([
      {
        id: 'p1',
        idempotencyKey: 'k1',
        content: 'hola',
        chatId: 'c1',
        createdAt: new Date().toISOString(),
        attempts: 1,
        maxAttempts: 3,
      },
    ])
    render(<OfflineBanner />)

    act(() => {
      setOnline(false)
      window.dispatchEvent(new Event('offline'))
    })
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument()

    act(() => {
      setOnline(true)
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => {
      expect(screen.getByTestId('offline-banner-recovery')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(pendingMessages.retryAll).toHaveBeenCalledTimes(1)
  })

  it('does not offer recovery when connectivity never dropped in this session', () => {
    vi.mocked(pendingMessages.getAll).mockReturnValue([
      {
        id: 'old',
        idempotencyKey: 'k2',
        content: 'viejo',
        chatId: 'c2',
        createdAt: new Date().toISOString(),
        attempts: 0,
        maxAttempts: 3,
      },
    ])
    // Stay online the whole time — no outage, no banner.
    const { container } = render(<OfflineBanner />)
    expect(container.firstChild).toBeNull()
    expect(pendingMessages.getAll).not.toHaveBeenCalled()
  })
})
