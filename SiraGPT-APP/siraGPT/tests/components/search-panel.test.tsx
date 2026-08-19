import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, screen, fireEvent } from '@testing-library/react'
import { SearchPanel } from '@/components/SearchPanel'

// Mock next/navigation — SearchPanel calls useRouter() and router.push().
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

// Mock lucide-react icons so the tree stays stable without depending on
// the upstream SVG payloads.
vi.mock('lucide-react', () => ({
  Search: (props: any) => <svg data-testid="search-icon" {...props} />,
  Loader2: (props: any) => <svg data-testid="loader-icon" {...props} />,
  AlertCircle: (props: any) => <svg data-testid="alert-icon" {...props} />,
  MessageSquare: (props: any) => <svg data-testid="message-icon" {...props} />,
}))

// Local UI primitives — render a minimal pass-through so vitest doesn't
// have to compile the full shadcn wrapper stack just for this test.
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
}))

const ORIGINAL_FETCH = globalThis.fetch

describe('SearchPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = ORIGINAL_FETCH
    vi.restoreAllMocks()
  })

  it('renders the empty (idle) state with no query', () => {
    globalThis.fetch = vi.fn() as any
    render(<SearchPanel />)
    // Idle copy mentions writing to search.
    expect(screen.getByText(/Escribe para buscar/i)).toBeInTheDocument()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('shows the loading state while the fetch is in flight', async () => {
    // Slow fetch — never resolves within the test window.
    const pending = new Promise(() => {})
    globalThis.fetch = vi.fn().mockReturnValue(pending) as any

    render(<SearchPanel />)
    const input = screen.getByLabelText('Search chats') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hola' } })

    // Trigger the 300ms debounce.
    await act(async () => {
      vi.advanceTimersByTime(350)
    })

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Buscando…/i)).toBeInTheDocument()
  })

  it('renders results with highlighted <mark> snippets', async () => {
    const hits = [
      {
        messageId: 'm-1',
        chatId: 'c-1',
        chatTitle: 'Recetas',
        role: 'USER',
        snippet: 'cómo hacer <mark>paella</mark> valenciana',
        timestamp: '2026-05-19T10:00:00Z',
        rank: 0.91,
      },
      {
        messageId: 'm-2',
        chatId: 'c-2',
        chatTitle: 'Viajes',
        role: 'ASSISTANT',
        snippet: 'la mejor <mark>paella</mark> está en Valencia',
        timestamp: '2026-05-19T11:00:00Z',
        rank: 0.55,
      },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: hits }),
    }) as any

    const { container } = render(<SearchPanel />)
    const input = screen.getByLabelText('Search chats') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'paella' } })

    // Debounce + microtask flush for the fetch promise chain.
    await act(async () => {
      vi.advanceTimersByTime(350)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Both chat titles rendered.
    expect(screen.getByText('Recetas')).toBeInTheDocument()
    expect(screen.getByText('Viajes')).toBeInTheDocument()

    // <mark> tags survive via dangerouslySetInnerHTML.
    const marks = container.querySelectorAll('mark')
    expect(marks.length).toBe(2)
    expect(marks[0].textContent).toBe('paella')

    // Fetch URL includes the query.
    const firstCall = (globalThis.fetch as any).mock.calls[0]
    expect(firstCall[0]).toMatch(/\/api\/search\?q=paella/)
  })

  it('shows a retry button on error and re-fires the fetch when clicked', async () => {
    // First call fails, second call succeeds — the retry button should
    // re-issue the last query without the user retyping it.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      })
    globalThis.fetch = fetchMock as any

    render(<SearchPanel />)
    const input = screen.getByLabelText('Search chats') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'paella' } })

    // Debounce + flush rejection.
    await act(async () => {
      vi.advanceTimersByTime(350)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Error state is on screen with a retry control.
    expect(screen.getByText(/Error al buscar|boom/i)).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: /retry search/i })
    expect(retry).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Click retry → second fetch fires with the same debounced query.
    await act(async () => {
      fireEvent.click(retry)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondCall = fetchMock.mock.calls[1]
    expect(secondCall[0]).toMatch(/\/api\/search\?q=paella/)
  })
})
