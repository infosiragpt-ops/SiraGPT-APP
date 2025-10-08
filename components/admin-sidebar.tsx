"use client"
import { BarChart3, Users, Settings, CreditCard, Database, Shield, Activity, FileText, Bot, LogOut } from "lucide-react"
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
} from "@/components/ui/sidebar"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useAuth } from "@/lib/auth-context-integrated"

const adminMenuItems = [
  {
    title: "Dashboard",
    icon: BarChart3,
    url: "/admin",
  },
  {
    title: "Users",
    icon: Users,
    url: "/admin/users",
  },
  {
    title: "AI Models",
    icon: Bot,
    url: "/admin/models",
  },
   {
     title: "Payments",
     icon: CreditCard,
     url: "/admin/payments",
   },
   {
     title: "Invoices",
     icon: FileText,
     url: "/admin/invoices",
   },
  {
    title: "Analytics",
    icon: Activity,
    url: "/admin/analytics",
  },
  {
    title: "Database",
    icon: Database,
    url: "/admin/database",
  },
  {
    title: "Security",
    icon: Shield,
    url: "/admin/security",
  },
  {
    title: "Reports",
    icon: FileText,
    url: "/admin/reports",
  },
  {
    title: "Settings",
    icon: Settings,
    url: "/admin/settings",
  },
]

export function AdminSidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const { user, logout } = useAuth()

  const handleNavigation = (url: string) => {
    router.push(url)
  }

  const handleLogout = () => {
    logout()
    router.push("/auth/login")
  }

  return (
    <Sidebar className="border-r border-border/40">
      <SidebarHeader className="border-b border-border/40 p-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-600">
            <Shield className="h-4 w-4 text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">Admin Panel</span>
            <span className="text-xs text-muted-foreground">Sira Gpt</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2">
        <SidebarGroup>
          <SidebarGroupLabel>Administration</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {adminMenuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    isActive={pathname === item.url}
                    onClick={() => handleNavigation(item.url)}
                    className="w-full justify-start cursor-pointer"
                  >
                    <item.icon className="mr-2 h-4 w-4" />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-border/40 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="w-full justify-start">
              <Avatar className="h-6 w-6">
                <AvatarImage src="/placeholder.svg?height=24&width=24" />
                <AvatarFallback>AD</AvatarFallback>
              </Avatar>
              <div className="flex flex-col items-start">
                <span className="text-sm">{user?.name || "Admin User"}</span>
                <span className="text-xs text-muted-foreground">Administrator</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleLogout} className="w-full justify-start text-red-600 cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" />
              <span>Logout</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
