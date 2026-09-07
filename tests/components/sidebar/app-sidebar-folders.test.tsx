import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppSidebar } from '@/components/app-sidebar'

const fixture = vi.hoisted(() => {
  const chat = { id: 'chat1', userId: 'account-a', title: 'Buscar tesis peruanas', createdAt: '2026-09-07T12:00:00Z', updatedAt: '2026-09-07T12:00:00Z', isPinned: false, isArchived: false, messages: [] }
  return {
    chat,
    user: { id: 'account-a', email: 'test@example.test', name: 'Luis', role: 'user' },
    api: {
      getUserSettings: vi.fn(), updateUserSettings: vi.fn(), getChat: vi.fn(), pinChat: vi.fn(), archiveChat: vi.fn(), updateChat: vi.fn(), handleShare: vi.fn(),
    },
    chatList: { chats: [chat], currentChatId: 'chat1', createNewChat: vi.fn(), setCurrentChat: vi.fn(), selectChat: vi.fn(), deleteChat: vi.fn(), loadMoreChats: vi.fn(), hasMoreChats: false, isLoadingMore: false, pagination: { page: 1, total: 1 }, isLoadingChats: false, getCurrentChatSnapshot: () => chat },
    router: { prefetch: vi.fn(), push: vi.fn(), back: vi.fn(), forward: vi.fn() },
    nav: { pendingHref: null, markNavigationIntent: vi.fn(), clearNavigationIntent: vi.fn() },
    streamMap: new Map(),
  }
})
vi.mock('@/lib/api', () => ({ apiClient: fixture.api }))
vi.mock('@/lib/auth-context-integrated', () => ({ useAuth: () => ({ user: fixture.user, logout: vi.fn() }) }))
vi.mock('@/lib/chat-context-integrated', () => ({ useChatList: () => fixture.chatList, useModelsAndFiles: () => ({ selectedModel: null, setSelectedModel: vi.fn() }) }))
vi.mock('@/lib/background-streams-context', () => ({ useBackgroundStreams: () => fixture.streamMap }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('next/navigation', () => ({ useRouter: () => fixture.router, usePathname: () => '/agentes' }))
vi.mock('next/link', () => ({ default: ({ children, prefetch, scroll, ...props }: any) => <a {...props}>{children}</a> }))
vi.mock('@/lib/agents-home-path', () => ({ isAgentsHomePath: (path: string) => path === '/agentes', agentsHomeHref: () => '/agentes' }))
vi.mock('@/components/navigation-transition-context', () => ({ normalizeNavigationHref: (path: string) => path, useNavigationTransition: () => fixture.nav }))
vi.mock('@/lib/agent-company-slot', () => ({ registerAgentCompanySlot: vi.fn() }))
vi.mock('@/lib/authenticated-fetch', () => ({ authenticatedFetch: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ui/sidebar', () => {
  const Wrap = React.forwardRef<HTMLDivElement, any>(function TestSidebarWrapper({ children, asChild, isActive, tooltip, collapsible, variant, ...props }, ref) { return asChild ? children : <div ref={ref} {...props}>{children}</div> })
  return { Sidebar: Wrap, SidebarContent: Wrap, SidebarFooter: Wrap, SidebarGroup: Wrap, SidebarGroupContent: Wrap, SidebarHeader: Wrap, SidebarMenu: Wrap, SidebarMenuButton: Wrap, SidebarMenuItem: Wrap, SidebarSeparator: () => null, SidebarTrigger: () => null,
    useSidebar: () => ({ state: 'open', toggleSidebar: vi.fn(), isMobile: false, setOpenMobile: vi.fn() }) }
})
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: any) => children, TooltipTrigger: ({ children }: any) => children, TooltipContent: () => null, TooltipProvider: ({ children }: any) => children }))
vi.mock('@/components/ui/alert-dialog', () => ({ AlertDialog: () => null, AlertDialogAction: () => null, AlertDialogCancel: () => null, AlertDialogContent: () => null, AlertDialogDescription: () => null, AlertDialogFooter: () => null, AlertDialogHeader: () => null, AlertDialogTitle: () => null }))
vi.mock('@/components/ui/avatar', () => ({ Avatar: ({ children }: any) => <span>{children}</span>, AvatarFallback: ({ children }: any) => <span>{children}</span>, AvatarImage: () => null }))
vi.mock('@/components/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }))
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }))
vi.mock('@/components/ui/input', () => ({ Input: React.forwardRef<HTMLInputElement, any>(function TestInput(props, ref) { return <input ref={ref} {...props} /> }) }))
vi.mock('@/components/ui/textarea', () => ({ Textarea: React.forwardRef<HTMLTextAreaElement, any>(function TestTextarea(props, ref) { return <textarea ref={ref} {...props} /> }) }))
vi.mock('@/components/icons/sidebar-oval-icon', () => ({ SidebarOvalIcon: () => null }))
vi.mock('@/components/UpgradeModal', () => ({ default: () => null }))
vi.mock('@/components/ChatSearchDialog', () => ({ ChatSearchDialog: () => null }))
vi.mock('@/components/settings/settings-dialog', () => ({ SettingsDialog: () => null }))
vi.mock('@/components/sidebar/sidebar-folders-dropdown', () => ({ SidebarFoldersDropdown: () => null }))
vi.mock('@/components/ui/thinking-indicator', () => ({ ThinkingIndicator: () => null }))
vi.mock('@/components/CreditsBadge', () => ({ CreditsBadge: () => null }))
vi.mock('@/components/notification-center', () => ({ default: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  fixture.api.getUserSettings.mockResolvedValue({ settings: { sidebarChatFolders: {
    version: 1, folders: [{ name: 'luis', isPinned: false, description: 'Investigación' }],
    assignments: [{ chatId: 'chat1', folder: 'luis' }], unreadIds: [], sections: [], chatSections: [],
  } } })
  fixture.api.updateUserSettings.mockResolvedValue({ success: true })
  fixture.api.getChat.mockResolvedValue({ chat: fixture.chat })
})

describe('AppSidebar folder integration', () => {
  it('hydrates, expands a folder, and opens project editing with the actual tree and state hook', async () => {
    const user = userEvent.setup()
    render(<AppSidebar />)
    const folder = await screen.findByRole('button', { name: 'Expandir carpeta luis' })
    await user.click(folder)
    const conversations = await screen.findByRole('list', { name: 'Conversaciones en luis' })
    expect(within(conversations).getByText('Buscar tesis peruanas')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Opciones de la carpeta luis' }))
    expect(screen.getByText('1 tarea')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Editar proyecto' }))
    expect(await screen.findByRole('dialog', { name: 'Editar proyecto' })).toBeVisible()
    expect(screen.getByDisplayValue('luis')).toBeVisible()
    expect(fixture.api.updateUserSettings).not.toHaveBeenCalled()
  })
})
