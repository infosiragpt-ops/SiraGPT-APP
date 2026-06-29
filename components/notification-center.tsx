"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle,
  Clock,
  CreditCard,
  ExternalLink,
  Info,
  Loader2,
  UserPlus,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { apiClient, type UserNotification } from "@/lib/api"
import { useAuth } from "@/lib/auth-context-integrated"
import { cn } from "@/lib/utils"

const POLL_INTERVAL_MS = 90_000

function formatTimeAgo(dateString: string) {
  const date = new Date(dateString)
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (!Number.isFinite(diff) || minutes < 1) return "Ahora"
  if (minutes < 60) return `${minutes} min`
  if (hours < 24) return `${hours} h`
  return `${days} d`
}

function notificationIcon(type: string) {
  switch (type) {
    case "org_invitation":
      return <UserPlus className="h-4 w-4 text-red-600" />
    case "usage_alert":
      return <AlertTriangle className="h-4 w-4 text-orange-500" />
    case "payment_failed":
      return <CreditCard className="h-4 w-4 text-red-600" />
    case "subscription_renewal":
      return <CheckCircle className="h-4 w-4 text-emerald-600" />
    case "plan_changed":
      return <Info className="h-4 w-4 text-blue-600" />
    case "subscription_expiring":
      return <Clock className="h-4 w-4 text-amber-500" />
    default:
      return <Bell className="h-4 w-4 text-muted-foreground" />
  }
}

function actionHref(notification: UserNotification) {
  const metadata = notification.metadata || {}
  const raw = typeof metadata.actionUrl === "string"
    ? metadata.actionUrl
    : typeof metadata.magicLink === "string"
      ? metadata.magicLink
      : ""
  const href = raw.trim()
  if (!href) return ""
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("/")) {
    return href
  }
  return `/${href}`
}

export default function NotificationCenter() {
  const { user } = useAuth()
  const [notifications, setNotifications] = useState<UserNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const fetchNotifications = useCallback(async (showLoading = false) => {
    if (!user) return
    try {
      if (showLoading) setLoading(true)
      const data = await apiClient.getNotifications(30)
      setNotifications(Array.isArray(data.items) ? data.items : [])
      setUnreadCount(Number(data.unreadCount) || 0)
    } catch (error) {
      console.error("Error fetching notifications:", error)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [user])

  useEffect(() => {
    if (!user) return
    void fetchNotifications(false)
    const interval = window.setInterval(() => {
      void fetchNotifications(false)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [fetchNotifications, user])

  useEffect(() => {
    if (open) void fetchNotifications(true)
  }, [fetchNotifications, open])

  const markAsRead = useCallback(async (notificationId: string) => {
    try {
      await apiClient.markNotificationRead(notificationId)
      setNotifications((prev) =>
        prev.map((notification) =>
          notification.id === notificationId
            ? { ...notification, read: true, readAt: new Date().toISOString() }
            : notification,
        ),
      )
      setUnreadCount((prev) => Math.max(0, prev - 1))
    } catch (error) {
      console.error("Error marking notification as read:", error)
      toast.error("No se pudo actualizar la notificación.")
    }
  }, [])

  const markAllAsRead = useCallback(async () => {
    try {
      await apiClient.markAllNotificationsRead()
      setNotifications((prev) =>
        prev.map((notification) => ({
          ...notification,
          read: true,
          readAt: notification.readAt || new Date().toISOString(),
        })),
      )
      setUnreadCount(0)
      toast.success("Notificaciones marcadas como leídas.")
    } catch (error) {
      console.error("Error marking all notifications as read:", error)
      toast.error("No se pudieron actualizar las notificaciones.")
    }
  }, [])

  const unreadLabel = useMemo(() => {
    if (unreadCount <= 0) return "Sin notificaciones nuevas"
    if (unreadCount === 1) return "1 notificación nueva"
    return `${unreadCount} notificaciones nuevas`
  }, [unreadCount])

  if (!user) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          aria-label={unreadLabel}
          title={unreadLabel}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] leading-none"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[min(380px,calc(100vw-24px))] overflow-hidden rounded-2xl p-0" align="end">
        <div className="border-b border-border/60 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">Notificaciones</h2>
              <p className="text-xs text-muted-foreground">{unreadLabel}</p>
            </div>
            {unreadCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 gap-1.5 px-2 text-xs"
                onClick={markAllAsRead}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Marcar todo
              </Button>
            )}
          </div>
        </div>

        <ScrollArea className="h-[420px] max-h-[min(420px,calc(100vh-160px))]">
          {loading && notifications.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Cargando notificaciones
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
              <Bell className="mb-3 h-8 w-8 text-muted-foreground/55" />
              <p className="text-sm font-medium text-foreground">Sin notificaciones</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Las invitaciones y avisos importantes aparecerán aquí.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {notifications.map((notification) => {
                const href = notification.type === "org_invitation" ? actionHref(notification) : ""
                const projectName = typeof notification.metadata?.projectName === "string"
                  ? notification.metadata.projectName
                  : ""

                return (
                  <div
                    key={notification.id}
                    className={cn(
                      "group cursor-pointer px-4 py-3 transition-colors hover:bg-muted/55",
                      !notification.read && "bg-red-50/70 dark:bg-red-950/15",
                    )}
                    onClick={() => {
                      if (!notification.read) void markAsRead(notification.id)
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background ring-1 ring-border/70">
                        {notificationIcon(notification.type)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className={cn(
                            "line-clamp-2 text-sm font-medium leading-5",
                            notification.read ? "text-foreground/80" : "text-foreground",
                          )}>
                            {notification.title}
                          </p>
                          {!notification.read && (
                            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-600" />
                          )}
                        </div>
                        <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
                          {notification.message}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="text-[11px] font-medium text-muted-foreground">
                            {formatTimeAgo(notification.createdAt)}
                          </span>
                          {projectName && (
                            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                              {projectName}
                            </span>
                          )}
                        </div>
                        {href && (
                          <Button
                            type="button"
                            size="sm"
                            className="mt-3 h-8 gap-1.5 rounded-lg bg-[#FF0000] px-3 text-xs font-semibold text-white hover:bg-[#d90000]"
                            onClick={async (event) => {
                              event.stopPropagation()
                              if (!notification.read) await markAsRead(notification.id)
                              window.location.assign(href)
                            }}
                          >
                            <UserPlus className="h-3.5 w-3.5" />
                            Aceptar invitación
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
