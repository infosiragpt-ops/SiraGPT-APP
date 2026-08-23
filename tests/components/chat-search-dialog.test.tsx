import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, screen, fireEvent } from '@testing-library/react'
import { ChatSearchDialog } from '@/components/ChatSearchDialog'

// next/navigation — the dialog reads useRouter/usePathname.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/chat',
}))

// next-intl — return the key plus interpolated values so assertions can
// target stable strings without loading real locale bundles.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (!values) return `chatSearch.${key}`
    const suffix = Object.values(values).join(',')
    return `chatSearch.${key}[${suffix}]`
  },
}))

// lucide-react icons — keep the tree light.
vi.mock('lucide-react', () => ({
  Search: IconStub('search'),
  History: IconStub('history'),
  Clock: IconStub('clock'),
  MessageSquare: IconStub('message-square'),
  MessageCircle: IconStub('message-circle'),
  CornerDownLeft: IconStub('corner-down-left'),
  ArrowUp: IconStub('arrow-up'),
  ArrowDown: IconStub('arrow-down'),
  X: IconStub('x'),
}))

function IconStub(name: string) {
  return (props: any) => <svg data-testid={`icon-${name}`} {...props} />
}

// UI primitives — minimal pass-throughs.
vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('@/components/ui/thinking-indicator', () => ({
  ThinkingIndicator: (props: any) => <span data-testid="thinking" {...props} />,
}))

const searchChatsMock = vi.fn()
vi.mock('@/lib/api', () => ({
  apiClient: {
    searchChats: (...args: any[]) => searchChatsMock(...args),
  },
}))

vi.mock('@/lib/chat-context-integrated', () => {
  // Stable identity across renders: the dialog's result effect depends on
  // `chats`, so a fresh array per render would loop forever.
  const CHATS = [
    { id: 'c-local', title: 'Plan de tesis local', updatedAt: '2026-08-20T10:00:00Z', messages: [] },
  ]
  return {
    useChat: () => ({
      chats: CHATS,
      selectChat: vi.fn(),
      loadMoreChats: vi.fn(),
      hasMoreChats: false,
      isLoadingMore: false,
    }),
  }
})

describe('ChatSearchDialog full-text search wiring', () => {
  const originalScrollIntoView = (HTMLElement.prototype as any).scrollIntoView

  beforeEach(() => {
    vi.useFakeTimers()
    searchChatsMock.mockReset()
    ;(HTMLElement.prototype as any).scrollIntoView = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    ;(HTMLElement.prototype as any).scrollIntoView = originalScrollIntoView
  })

  it('queries the server FTS endpoint after the debounce and renders deduped chat hits with snippets', async () => {
    searchChatsMock.mockResolvedValue({
      query: 'metodología',
      results: [
        {
          messageId: 'm-1',
          chatId: 'c-1',
          chatTitle: 'Tesis metodología',
          role: 'USER',
          snippet: 'mi <mark>metodología</mark> es mixta',
          timestamp: '2026-08-01T10:00:00Z',
          rank: 0.9,
        },
        {
          messageId: 'm-2',
          chatId: 'c-1',
          chatTitle: 'Tesis metodología',
          role: 'ASSISTANT',
          snippet: 'segundo hit del mismo chat <mark>metodología</mark>',
          timestamp: '2026-08-01T10:05:00Z',
          rank: 0.4,
        },
        {
          messageId: 'm-3',
          chatId: 'c-2',
          chatTitle: 'Asesoría',
          role: 'USER',
          snippet: 'otra <mark>metodología</mark>',
          timestamp: '2026-07-15T09:00:00Z',
          rank: 0.2,
        },
      ],
    })

    render(<ChatSearchDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'metodología' } })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(searchChatsMock).toHaveBeenCalledTimes(1)
    expect(searchChatsMock).toHaveBeenCalledWith(
      'metodología',
      expect.objectContaining({ limit: 30 })
    )

    // One row per chat — duplicate hits for c-1 collapse to the best rank.
    // Titles render through highlightSearchTerm, so matched words are
    // wrapped in <mark>; assert on the row container text instead of a
    // single text node.
    const titleRows = screen.getAllByText((_, element) =>
      element?.textContent === 'Tesis metodología' &&
      element.tagName === 'DIV' && element.className.includes('truncate')
        ? true
        : undefined
    )
    expect(titleRows.length).toBe(1)
    expect(screen.getByText('Asesoría')).toBeInTheDocument()

    // Snippet highlights survive via dangerouslySetInnerHTML (2 snippets +
    // 1 in the highlighted title = 3 marks total).
    const marks = document.querySelectorAll('mark')
    expect(marks.length).toBe(3)
  })

  it('falls back to local title matches when the server search fails', async () => {
    searchChatsMock.mockRejectedValue(new Error('server down'))

    render(<ChatSearchDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'tesis' } })

    // Debounce + any client-side retry backoff must elapse inside fake
    // time before the rejection surfaces.
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The locally loaded chat whose title matches is still offered
    // (title contains the query, so it renders with a <mark> inside)
    // instead of a dead end.
    expect(
      screen.getByText((_, element) => element?.textContent === 'Plan de tesis local')
    ).toBeInTheDocument()
  })

  it('shows the fallback notice when the server search fails with no local matches', async () => {
    searchChatsMock.mockRejectedValue(new Error('server down'))

    render(<ChatSearchDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'sin-coincidencia-zz' } })

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('chatSearch.serverFallback')).toBeInTheDocument()
  })

  it('aborts the in-flight request when a newer query replaces it', async () => {
    let resolveFirst: (value: any) => void = () => {}
    searchChatsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    searchChatsMock.mockResolvedValueOnce({ query: 'b', results: [] })

    render(<ChatSearchDialog open onOpenChange={vi.fn()} />)
    const input = screen.getByRole('textbox')

    fireEvent.change(input, { target: { value: 'primera consulta' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    const firstSignal = searchChatsMock.mock.calls[0][1].signal as AbortSignal
    expect(firstSignal.aborted).toBe(false)

    fireEvent.change(input, { target: { value: 'segunda' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    // The first request was aborted by the second query's effect.
    expect(firstSignal.aborted).toBe(true)
    expect(searchChatsMock).toHaveBeenCalledTimes(2)
    void resolveFirst
  })

  it('renders loaded recents without calling the server when the query is empty', async () => {
    render(<ChatSearchDialog open onOpenChange={vi.fn()} />)

    await act(async () => {
      vi.advanceTimersByTime(300)
    })

    expect(searchChatsMock).not.toHaveBeenCalled()
    expect(screen.getByText('Plan de tesis local')).toBeInTheDocument()
  })
})
