import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { ErrorBoundary } from '@/components/error-boundary'

vi.mock('lucide-react', () => ({
  AlertTriangle: () => <svg data-testid="alert-triangle" />,
  RotateCcw: () => <svg data-testid="rotate-ccw" />,
}))

vi.mock('@/lib/analytics', () => ({
  track: vi.fn(),
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}))

function Boom(): JSX.Element {
  throw new Error('Snapshot crash')
}

describe('ErrorBoundary fallback (snapshot)', () => {
  // The component logs the captured error in componentDidCatch; silence
  // the noise so test output stays readable without affecting behaviour.
  const originalError = console.error
  beforeEach(() => {
    console.error = vi.fn()
  })
  afterEach(() => {
    console.error = originalError
  })

  it('renders default fallback in dev mode', () => {
    const { container } = render(
      <ErrorBoundary label="snapshot-test">
        <Boom />
      </ErrorBoundary>,
    )
    expect(container.firstChild).toMatchSnapshot()
  })
})
