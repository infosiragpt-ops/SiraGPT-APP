import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ErrorBoundary } from '@/components/error-boundary'
import * as analytics from '@/lib/analytics'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  AlertTriangle: () => <svg data-testid="alert-triangle" />,
  RotateCcw: () => <svg data-testid="rotate-ccw" />,
}))

// Mock the analytics tracker
vi.mock('@/lib/analytics', () => ({
  track: vi.fn(),
}))

// Mock the button component
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}))

// A component that throws on render
function BuggyComponent({ shouldThrow = false }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('Test crash!')
  }
  return <div data-testid="healthy-child">Working</div>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Suppress console.error during error boundary tests
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary label="test">
        <div data-testid="child">OK</div>
      </ErrorBoundary>
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()
  })

  it('renders default fallback when child throws', () => {
    render(
      <ErrorBoundary label="test">
        <BuggyComponent shouldThrow />
      </ErrorBoundary>
    )
    expect(screen.getByText('No se pudo renderizar este contenido')).toBeInTheDocument()
    expect(screen.getByText('Test crash!')).toBeInTheDocument()
    expect(screen.getByText('Reintentar')).toBeInTheDocument()
  })

  it('shows "Error desconocido" when error has no message', () => {
    function NoMessageThrower() {
      throw new Error()
    }
    render(
      <ErrorBoundary label="test">
        <NoMessageThrower />
      </ErrorBoundary>
    )
    expect(screen.getByText('Error desconocido')).toBeInTheDocument()
  })

  it('calls the custom fallback render prop', () => {
    const customFallback = vi.fn((error: Error, reset: () => void) => (
      <div data-testid="custom-fallback">
        <span>Custom: {error.message}</span>
        <button onClick={reset}>Reset</button>
      </div>
    ))

    render(
      <ErrorBoundary label="test" fallback={customFallback}>
        <BuggyComponent shouldThrow />
      </ErrorBoundary>
    )

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument()
    expect(screen.getByText('Custom: Test crash!')).toBeInTheDocument()
    expect(customFallback).toHaveBeenCalled()
    expect(customFallback.mock.calls[0][0].message).toBe('Test crash!')
  })

  it('calls onError callback when error is caught', () => {
    const onError = vi.fn()

    render(
      <ErrorBoundary label="test" onError={onError}>
        <BuggyComponent shouldThrow />
      </ErrorBoundary>
    )

    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0][0].message).toBe('Test crash!')
  })

  it('includes label in console.error output', () => {
    const consoleSpy = vi.spyOn(console, 'error')
    const boundaryLabel = 'chat:message-list'

    render(
      <ErrorBoundary label={boundaryLabel}>
        <BuggyComponent shouldThrow />
      </ErrorBoundary>
    )

    expect(consoleSpy).toHaveBeenCalled()
    const logCall = consoleSpy.mock.calls.find(
      ([msg]: [string]) => typeof msg === 'string' && msg.includes(boundaryLabel)
    )
    expect(logCall).toBeTruthy()
  })

  it('reset clears error and re-renders children', () => {
    // Use a state variable to toggle error
    let throwErr = true
    function ToggleError() {
      if (throwErr) throw new Error('Boom')
      return <div data-testid="recovered">Recovered</div>
    }

    // First render with error
    const { rerender } = render(
      <ErrorBoundary label="toggle">
        <ToggleError />
      </ErrorBoundary>
    )

    // Error should be shown
    expect(screen.getByText('No se pudo renderizar este contenido')).toBeInTheDocument()
    expect(screen.getByText('Boom')).toBeInTheDocument()

    // Fix the error source FIRST, then reset
    throwErr = false

    // Click Reintentar — this triggers reset()
    fireEvent.click(screen.getByText('Reintentar'))

    // Rerender with fixed component
    rerender(
      <ErrorBoundary label="toggle">
        <ToggleError />
      </ErrorBoundary>
    )

    // Should show recovered state
    expect(screen.getByTestId('recovered')).toBeInTheDocument()
    expect(screen.getByText('Recovered')).toBeInTheDocument()
  })

  it('calls analytics track on error', () => {
    render(
      <ErrorBoundary label="test:boundary">
        <BuggyComponent shouldThrow />
      </ErrorBoundary>
    )

    expect(analytics.track).toHaveBeenCalledWith('error.client_boundary', expect.objectContaining({
      label: 'test:boundary',
      name: 'Error',
      message: 'Test crash!',
    }))
  })
})
