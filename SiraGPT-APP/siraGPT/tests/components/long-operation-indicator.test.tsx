import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { LongOperationIndicator } from '@/components/chat/LongOperationIndicator'

// Mock lucide-react icons so the snapshot is stable.
vi.mock('lucide-react', () => ({
  Loader2: (props: any) => <svg data-testid="loader" {...props} />,
  X: (props: any) => <svg data-testid="x-icon" {...props} />,
}))

describe('LongOperationIndicator (snapshot)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null when inactive', () => {
    const { container } = render(<LongOperationIndicator active={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders at ~5s elapsed (not slow)', () => {
    const { container } = render(<LongOperationIndicator active={true} label="Generando…" />)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(container.firstChild).toMatchSnapshot()
  })

  it('renders at ~35s elapsed (slow state)', () => {
    const { container } = render(
      <LongOperationIndicator active={true} label="Generando…" slowThresholdMs={30_000} />,
    )
    act(() => {
      vi.advanceTimersByTime(35_000)
    })
    expect(container.firstChild).toMatchSnapshot()
  })
})
