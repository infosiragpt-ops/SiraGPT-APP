"use client"

import {
  BarChart3,
  Users,
  Settings,
  CreditCard,
  Database,
  Shield,
  Activity,
  FileText,
  Bot,
  Heart,
  LogOut,
  PanelLeft,
  ArrowLeft,
  Plug,
  ScrollText,
} from "lucide-react"
import { useRouter, usePathname } from "next/navigation"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useAuth } from "@/lib/auth-context-integrated"
import { cn } from "@/lib/utils"

const adminMenuItems = [
  { title: "Panel", icon: BarChart3, url: "/admin" },
  { title: "Usuarios", icon: Users, url: "/admin/users" },
  { title: "Modelos IA", icon: Bot, url: "/admin/models" },
  { title: "Conexiones", icon: Plug, url: "/admin/connections" },
  { title: "Pagos", icon: CreditCard, url: "/admin/payments" },
  { title: "Facturas", icon: FileText, url: "/admin/invoices" },
  { title: "Métricas", icon: Activity, url: "/admin/analytics" },
  { title: "Logs", icon: ScrollText, url: "/admin/logs" },
  { title: "Base de datos", icon: Database, url: "/admin/database" },
  { title: "Seguridad", icon: Shield, url: "/admin/security" },
  { title: "Reportes", icon: FileText, url: "/admin/reports" },
  { title: "Estado", icon: Heart, url: "/admin/health" },
  { title: "Ajustes", icon: Settings, url: "/admin/settings" },
]

function getInitials(name?: string | null, email?: string | null) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  if (parts[0]) return parts[0].slice(0, 2).toUpperCase()
  if (email) return email.slice(0, 2).toUpperCase()
  return "AD"
}

function isItemActive(pathname: string, url: string) {
  if (url === "/admin") return pathname === "/admin"
  return pathname === url || pathname.startsWith(`${url}/`)
}

const navButtonClass =
  "admin-nav-item h-11 rounded-none border-l-2 border-transparent bg-transparent px-2.5 text-[13px] font-normal text-zinc-600 shadow-none hover:bg-zinc-900/[0.04] hover:text-zinc-900 data-[active=true]:border-zinc-900 data-[active=true]:bg-zinc-900/[0.05] data-[active=true]:font-medium data-[active=true]:text-zinc-900 data-[active=true]:shadow-none md:h-8"

export function AdminSidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const { user, logout } = useAuth()
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar()
  const initials = getInitials(user?.name, user?.email)
  const expanded = state === "open" || isMobile

  const handleNavigation = (url: string) => {
    router.push(url)
    if (isMobile) setOpenMobile(false)
  }

  const handleLogout = () => {
    logout()
    router.push("/auth/login")
  }

  return (
    <Sidebar
      className="admin-sidebar-drawer admin-shell-v20260815 border-r border-zinc-200/80 bg-white"
      collapsible="icon"
    >
      <SidebarHeader
        className={cn(
          "admin-sidebar-header flex-shrink-0 border-b border-zinc-200/80",
          expanded ? "px-3 py-2.5" : "p-2",
        )}
      >
        <div className={cn("flex items-center justify-between gap-2", !expanded && "hidden")}>
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-red-600">
              <Shield className="h-3.5 w-3.5 text-white" strokeWidth={1.75} />
            </div>
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[13px] font-semibold tracking-tight text-zinc-900">
                Administración
              </span>
              <span className="text-[11px] text-zinc-400">Sira GPT</span>
            </div>
          </div>
          <SidebarTrigger className="hidden h-8 w-8 md:inline-flex" />
        </div>
        <div className={cn("relative", expanded && "hidden")}>
          <button
            type="button"
            className="group flex h-8 w-8 items-center justify-center rounded-md bg-red-600"
            onClick={toggleSidebar}
            aria-label="Expandir menú"
          >
            <Shield className="h-3.5 w-3.5 text-white transition-opacity group-hover:opacity-0" strokeWidth={1.75} />
            <PanelLeft className="absolute h-3.5 w-3.5 text-white opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={1.75} />
          </button>
        </div>
      </SidebarHeader>

      <SidebarContent className="admin-sidebar-nav px-1.5 py-1 overflow-y-auto">
        <SidebarGroup className="p-1 pb-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0">
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => handleNavigation("/chat")}
                  className="h-10 w-full justify-start rounded-md px-2.5 text-[12px] font-normal text-zinc-400 hover:bg-transparent hover:text-zinc-700 md:h-8"
                  tooltip={expanded ? undefined : "Volver al chat"}
                >
                  <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  {expanded && <span>Volver al chat</span>}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="p-1 pt-1">
          <SidebarGroupLabel className="mb-0.5 h-6 px-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400">
            Menú
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0">
              {adminMenuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    isActive={isItemActive(pathname, item.url)}
                    onClick={() => handleNavigation(item.url)}
                    className={navButtonClass}
                    tooltip={expanded ? undefined : item.title}
                  >
                    <item.icon className="!h-4 !w-4 shrink-0" strokeWidth={1.75} />
                    {expanded && <span className="truncate">{item.title}</span>}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="admin-sidebar-footer flex-shrink-0 border-t border-zinc-200/80 p-2">
        <div className={cn("flex items-center gap-2 rounded-md px-1.5 py-1.5", !expanded && "justify-center px-0")}>
          <Avatar className="h-7 w-7">
            {user?.avatar ? <AvatarImage src={user.avatar} alt={user.name} /> : null}
            <AvatarFallback className="bg-zinc-900 text-[10px] font-medium text-white">
              {initials}
            </AvatarFallback>
          </Avatar>
          {expanded && (
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[13px] font-medium text-zinc-900">
                {user?.name || "Administrador"}
              </div>
              <div className="text-[11px] text-zinc-400">Administrador</div>
            </div>
          )}
        </div>
        <SidebarMenu className="gap-0">
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleLogout}
              className="h-10 w-full justify-start rounded-md px-2.5 text-[12px] font-normal text-zinc-500 hover:bg-red-50 hover:text-red-600 md:h-8"
              tooltip={expanded ? undefined : "Cerrar sesión"}
            >
              <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              {expanded && <span>Cerrar sesión</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
