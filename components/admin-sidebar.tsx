"use client"
import { BarChart3, Users, Settings, CreditCard, Database, Shield, Activity, FileText, Bot, Heart, LogOut, PanelLeft, ArrowLeft, Plug } from "lucide-react"
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
  {
    title: "Panel",
    icon: BarChart3,
    url: "/admin",
  },
  {
    title: "Usuarios",
    icon: Users,
    url: "/admin/users",
  },
  {
    title: "Modelos IA",
    icon: Bot,
    url: "/admin/models",
  },
  {
    title: "Conexiones",
    icon: Plug,
    url: "/admin/connections",
  },
   {
     title: "Pagos",
     icon: CreditCard,
     url: "/admin/payments",
   },
   {
     title: "Facturas",
     icon: FileText,
     url: "/admin/invoices",
   },
  {
    title: "Métricas",
    icon: Activity,
    url: "/admin/analytics",
  },
  {
    title: "Base de datos",
    icon: Database,
    url: "/admin/database",
  },
  {
    title: "Seguridad",
    icon: Shield,
    url: "/admin/security",
  },
  {
    title: "Reportes",
    icon: FileText,
    url: "/admin/reports",
  },
  {
    title: "Estado",
    icon: Heart,
    url: "/admin/health",
  },
  {
    title: "Ajustes",
    icon: Settings,
    url: "/admin/settings",
  },
]

export function AdminSidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const { user, logout } = useAuth()
  const { state, toggleSidebar } = useSidebar()
  const handleNavigation = (url: string) => {
    router.push(url)
  }

  const handleLogout = () => {
    logout()
    router.push("/auth/login")
  }

  return (
    <Sidebar className="border-r border-border/40" collapsible="icon">
        <SidebarHeader
        className={cn(
          "border-b border-border/40 transition-all flex-shrink-0",
          state === "open" ? "p-3" : "p-2"
        )}
      >
        {/* When sidebar is open - show full layout */}
        <div
          className={cn(
            "flex items-center justify-between",
            state === "closed" && "hidden"
          )}
        >
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-600">
            <Shield className="h-4 w-4 text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">Panel de administración</span>
            <span className="text-xs text-muted-foreground">Sira GPT</span>
           </div>
          </div>
          <SidebarTrigger />
        </div>
           {/* When sidebar is closed - show only icon */}
        <div className={cn("relative", state === "open" && "hidden")}>
          <div
            className="group flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 cursor-pointer"
            onClick={toggleSidebar}
          >
            <Shield className="h-4 w-4 text-white transition-opacity group-hover:opacity-0" />
            <PanelLeft className="h-4 w-4 text-white absolute opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2 overflow-y-auto">
        {/* Back-to-app escape hatch — admin panel has no top-bar, so without
            this button users get stuck inside /admin with no way out. */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => handleNavigation("/chat")}
                  className="w-full justify-start cursor-pointer"
                  tooltip={state === "closed" ? "Volver al chat" : undefined}
                >
                  <ArrowLeft className="h-4 w-4 flex-shrink-0" />
                  {state === "open" && <span className="ml-2">Volver al chat</span>}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Administración</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {adminMenuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    isActive={pathname === item.url}
                    onClick={() => handleNavigation(item.url)}
                    className="w-full justify-start cursor-pointer"
                    tooltip={state === "closed" ? item.title : undefined}
                  >
                     <item.icon className="h-4 w-4 flex-shrink-0" />
                    {state === "open" && <span className="ml-2">{item.title}</span>}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-border/40 p-2 flex-shrink-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="w-full justify-start">
              <Avatar className="h-6 w-6">
                <AvatarImage src="/placeholder.svg?height=24&width=24" />
                <AvatarFallback>AD</AvatarFallback>
              </Avatar>
             {state === "open" && (
                <div className="flex flex-col items-start">
                  <span className="text-sm">{user?.name || "Administrador"}</span>
                  <span className="text-xs text-muted-foreground">Administrador</span>
                </div>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleLogout} className="w-full justify-start text-red-600 cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" />
                {state === "open" && <span>Cerrar sesión</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
