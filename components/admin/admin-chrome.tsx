"use client"

import type { ComponentType, ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

export function AdminPageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string
  description?: string
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={cn("admin-page-header", className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        <SidebarTrigger className="admin-menu-trigger md:hidden" />
        <div className="min-w-0">
          <h1 className="admin-page-title">{title}</h1>
          {description ? <p className="admin-page-desc">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="admin-page-actions">{actions}</div> : null}
    </header>
  )
}

export function AdminStatCard({
  title,
  value,
  description,
  icon: Icon,
  valueClassName,
}: {
  title: string
  value: ReactNode
  description?: string
  icon?: LucideIcon | ComponentType<{ className?: string; strokeWidth?: number }>
  valueClassName?: string
}) {
  return (
    <div className="admin-stat">
      <div className="admin-stat-top">
        <span className="admin-stat-label">{title}</span>
        {Icon ? <Icon className="admin-stat-icon" strokeWidth={1.75} /> : null}
      </div>
      <div className={cn("admin-stat-value", valueClassName)}>{value}</div>
      {description ? <p className="admin-stat-desc">{description}</p> : null}
    </div>
  )
}

export function AdminPageBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={cn("admin-page-body", className)}>{children}</div>
}
