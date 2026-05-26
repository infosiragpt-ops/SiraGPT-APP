import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ProviderErrorBoundary } from '@/components/provider-error-boundary'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  AlertTriangle: () => <svg data-testid="alert-triangle" />,
  RefreshCw: () => <svg data-testid="refresh-cw" />,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}))

// A provider that throws on render
function BuggyProvider({ shouldThrow = false }: { shouldThrow?: boolean }) {
  if (shouldThrow) {
    throw new Error('Provider crashed!')
  }
  return <div data-testid="healthy-provider">Working</div>
}

describe('ProviderErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('renders children when no error occurs', () => {
    render(
      <ProviderErrorBoundary name="AuthProvider">
        <div data-testid="child">OK</div>
      </ProviderErrorBoundary>
    )
    expect(screen.getByTestId('child')).toBeInTheDocument()
    expect(screen.getByText('OK')).toBeInTheDocument()
  })

  it('renders fallback UI when child throws', () => {
    render(
      <ProviderErrorBoundary name="ChatProvider">
        <BuggyProvider shouldThrow />
      </ProviderErrorBoundary>
    )

    expect(screen.getByText('Error en ChatProvider')).toBeInTheDocument()
    expect(screen.getByText('Provider crashed!')).toBeInTheDocument()
    expect(screen.getByText('Reintentar')).toBeInTheDocument()
  })

  it('shows "Error desconocido" when error has no message', () => {
    function SilentCrash() {
      throw new Error()
    }
    render(
      <ProviderErrorBoundary name="Silent">
        <SilentCrash />
      </ProviderErrorBoundary>
    )
    expect(screen.getByText('Error desconocido')).toBeInTheDocument()
  })

  it('resets and re-renders children on Reintentar click', () => {
    let throwError = true
    function ToggleProvider() {
      if (throwError) throw new Error('Temporary')
      return <div data-testid="recovered">Recovered</div>
    }

    const { rerender } = render(
      <ProviderErrorBoundary name="Toggle">
        <ToggleProvider />
      </ProviderErrorBoundary>
    )

    expect(screen.getByText('Error en Toggle')).toBeInTheDocument()

    // Fix the error source
    throwError = false

    // Click Reintentar
    fireEvent.click(screen.getByText('Reintentar'))

    // Rerender with fixed component
    rerender(
      <ProviderErrorBoundary name="Toggle">
        <ToggleProvider />
      </ProviderErrorBoundary>
    )

    expect(screen.getByTestId('recovered')).toBeInTheDocument()
    expect(screen.getByText('Recovered')).toBeInTheDocument()
  })

  it('logs error with provider name in console', () => {
    const consoleSpy = vi.spyOn(console, 'error')

    render(
      <ProviderErrorBoundary name="AuthProvider">
        <BuggyProvider shouldThrow />
      </ProviderErrorBoundary>
    )

    expect(consoleSpy).toHaveBeenCalled()
    const logCall = consoleSpy.mock.calls.find(
      ([msg]: [string]) => typeof msg === 'string' && msg.includes('AuthProvider')
    )
    expect(logCall).toBeTruthy()
  })

  it('shows limited functionality message', () => {
    render(
      <ProviderErrorBoundary name="Chat">
        <BuggyProvider shouldThrow />
      </ProviderErrorBoundary>
    )

    expect(screen.getByText(/funcionalidad limitada/i)).toBeInTheDocument()
  })
})
