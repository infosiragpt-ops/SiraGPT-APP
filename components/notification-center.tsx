"use client"

import { useState, useEffect } from 'react'
import { Bell, X, Clock, CreditCard, AlertTriangle, CheckCircle, Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { apiClient } from '@/lib/api'
import { useAuth } from '@/lib/auth-context-integrated'
import { toast } from 'sonner'

interface Notification {
  id: string
  type: string
  title: string
  message: string
  read: boolean
  createdAt: string
  metadata?: any
}

export default function NotificationCenter() {
  const { user } = useAuth()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (user) {
      fetchNotifications()
      // Poll for new notifications every 30 seconds
      const interval = setInterval(fetchNotifications, 30000)
      return () => clearInterval(interval)
    }
  }, [user])

  const fetchNotifications = async () => {
    try {
      setLoading(true)
      const data = await apiClient.getNotifications(20)
      setNotifications(data.notifications || [])
      setUnreadCount(data.unreadCount || 0)
    } catch (error) {
      console.error('Error fetching notifications:', error)
    } finally {
      setLoading(false)
    }
  }

  const markAsRead = async (notificationId: string) => {
    try {
      await apiClient.markNotificationRead(notificationId)
      
      setNotifications(prev =>
        prev.map(notif =>
          notif.id === notificationId ? { ...notif, read: true } : notif
        )
      )
      
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch (error) {
      console.error('Error marking notification as read:', error)
      toast.error('Failed to mark notification as read')
    }
  }

  const markAllAsRead = async () => {
    try {
      const unreadNotifications = notifications.filter(n => !n.read)
      
      await Promise.all(
        unreadNotifications.map(notif => 
          apiClient.markNotificationRead(notif.id)
        )
      )
      
      setNotifications(prev =>
        prev.map(notif => ({ ...notif, read: true }))
      )
      
      setUnreadCount(0)
      toast.success('All notifications marked as read')
    } catch (error) {
      console.error('Error marking all notifications as read:', error)
      toast.error('Failed to mark notifications as read')
    }
  }

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'usage_alert':
        return <AlertTriangle className="h-4 w-4 text-orange-500" />
      case 'payment_failed':
        return <CreditCard className="h-4 w-4 text-red-500" />
      case 'subscription_renewal':
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case 'plan_changed':
        return <Info className="h-4 w-4 text-blue-500" />
      case 'subscription_expiring':
        return <Clock className="h-4 w-4 text-yellow-500" />
      default:
        return <Bell className="h-4 w-4 text-gray-500" />
    }
  }

  const getNotificationColor = (type: string) => {
    switch (type) {
      case 'usage_alert':
        return 'bg-orange-50 border-orange-200 dark:bg-orange-950/20'
      case 'payment_failed':
        return 'bg-red-50 border-red-200 dark:bg-red-950/20'
      case 'subscription_renewal':
        return 'bg-green-50 border-green-200 dark:bg-green-950/20'
      case 'plan_changed':
        return 'bg-blue-50 border-blue-200 dark:bg-blue-950/20'
      case 'subscription_expiring':
        return 'bg-yellow-50 border-yellow-200 dark:bg-yellow-950/20'
      default:
        return 'bg-gray-50 border-gray-200 dark:bg-gray-950/20'
    }
  }

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)
    
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return `${days}d ago`
  }

  if (!user) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative"
          onClick={() => setOpen(!open)}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      
      <PopoverContent className="w-96 p-0" align="end">
        <Card className="border-0 shadow-lg">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Notifications</CardTitle>
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={markAllAsRead}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Mark all read
                </Button>
              )}
            </div>
            {unreadCount > 0 && (
              <CardDescription>
                {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
              </CardDescription>
            )}
          </CardHeader>
          
          <CardContent className="p-0">
            <ScrollArea className="h-96">
              {loading && notifications.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-pulse">Loading notifications...</div>
                </div>
              ) : notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Bell className="h-8 w-8 text-gray-400 mb-2" />
                  <p className="text-sm text-muted-foreground">No notifications</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    You're all caught up!
                  </p>
                </div>
              ) : (
                <div className="space-y-1 p-2">
                  {notifications.map((notification) => (
                    <div
                      key={notification.id}
                      className={`p-3 rounded-lg border cursor-pointer transition-colors hover:bg-muted/50 ${
                        !notification.read
                          ? getNotificationColor(notification.type)
                          : 'bg-background'
                      }`}
                      onClick={() => {
                        if (!notification.read) {
                          markAsRead(notification.id)
                        }
                      }}
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 mt-0.5">
                          {getNotificationIcon(notification.type)}
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <p className={`text-sm font-medium truncate ${
                              !notification.read ? 'text-foreground' : 'text-muted-foreground'
                            }`}>
                              {notification.title}
                            </p>
                            {!notification.read && (
                              <div className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0" />
                            )}
                          </div>
                          
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {notification.message}
                          </p>
                          
                          <p className="text-xs text-muted-foreground mt-2">
                            {formatTimeAgo(notification.createdAt)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </PopoverContent>
    </Popover>
  )
}