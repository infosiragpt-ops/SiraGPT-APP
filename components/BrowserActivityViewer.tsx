"use client"

import React, { useState, useEffect, useRef } from 'react'
import { Minimize2, Maximize2, X, Monitor, ExternalLink} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { apiClient } from '@/lib/api'

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface BrowserActivityViewerProps {
  sessionId: string
  onClose?: () => void
}

interface BrowserActivity {
  currentSource?: string
  currentUrl?: string
  currentScreenshot?: string
  screenshots?: Array<{
    source: string
    filename: string
    url: string
    timestamp: string
  }>
  message?: string
  status?: string
}

const BrowserActivityViewer: React.FC<BrowserActivityViewerProps> = ({ sessionId, onClose }) => {
  const [isMinimized, setIsMinimized] = useState(false)
  const [isSplitView, setIsSplitView] = useState(false)
  const [activity, setActivity] = useState<BrowserActivity | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [currentImageUrl, setCurrentImageUrl] = useState<string | null>(null)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Poll for browser activity updates
  useEffect(() => {
    const pollActivity = async () => {
      try {
        const status = await apiClient.getThesisStatus(sessionId)
        
        setActivity({
          currentSource: status.currentSource,
          currentUrl: status.currentUrl,
          currentScreenshot: status.currentScreenshot,
          screenshots: status.screenshots,
          message: status.message,
          status: status.status
        })

        // Update screenshot URL if available
        if (status.currentScreenshot && status.currentSource) {
          const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'
          const screenshotUrl = `${apiBaseUrl}/thesis/screenshots/${sessionId}/${status.currentScreenshot}`
          setCurrentImageUrl(screenshotUrl)
        } else {
          // If no current screenshot, try to use the latest from history
          if (status.screenshots && status.screenshots.length > 0) {
            const latestScreenshot = status.screenshots[status.screenshots.length - 1]
            const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'
            const screenshotUrl = `${apiBaseUrl}/thesis/screenshots/${sessionId}/${latestScreenshot.filename}`
            setCurrentImageUrl(screenshotUrl)
          }
        }

        setIsLoading(false)

        // Stop polling if completed or error
        if (status.status === 'completed' || status.status === 'error') {
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
        }
      } catch (error) {
        console.error('Error fetching browser activity:', error)
        setIsLoading(false)
      }
    }

    // Initial fetch
    pollActivity()

    // Poll every 2 seconds for real-time updates
    pollIntervalRef.current = setInterval(pollActivity, 2000)

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [sessionId])

  const handleMinimize = () => {
    setIsMinimized(!isMinimized)
    setIsSplitView(false) // Disable split view when minimizing
  }

  const handleSplitView = () => {
    setIsSplitView(!isSplitView)
    setIsMinimized(false) // Disable minimize when split view is active
  }

  // Minimized view (small bar at top)
  if (isMinimized) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-background border-b shadow-lg">
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3">
            <Monitor className="h-4 w-4 text-primary" />
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Browser Activity</span>
              {activity?.currentSource && (
                <Badge variant="secondary" className="text-xs">
                  {activity.currentSource}
                </Badge>
              )}
            </div>
            {activity?.currentUrl && (
              <a
                href={activity.currentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-primary truncate max-w-xs"
              >
                {activity.currentUrl}
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* <Button
              variant="ghost"
              size="sm"
              onClick={handleMinimize}
              className="h-7 px-2"
            >
              <Maximize2 className="h-3 w-3" />
            </Button> */}
            {onClose && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="h-7 px-2"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Full view or split view
  return (
    <Card className={`${isSplitView ? 'fixed bottom-4 right-4 w-[600px] h-[500px] z-50 shadow-2xl border-2 border-primary/30' : 'w-full border-2 border-primary/20'} transition-all duration-300`}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b bg-muted/50">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Browser Activity</span>
          {activity?.currentSource && (
            <Badge variant="secondary" className="text-xs">
              {activity.currentSource}
            </Badge>
          )}
          {isLoading && (
            <ThinkingIndicator size="xs" className="text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSplitView}
            className="h-7 px-2"
            title={isSplitView ? "Exit Split View" : "Split View"}
          >
            <Monitor className="h-3 w-3" />
          </Button>
          {/* <Button
            variant="ghost"
            size="sm"
            onClick={handleMinimize}
            className="h-7 px-2"
            title="Minimize"
          >
            <Minimize2 className="h-3 w-3" />
          </Button> */}
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-7 px-2"
              title="Close"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className={`${isSplitView ? 'h-[calc(100%-60px)]' : 'min-h-[400px]'} overflow-auto bg-gradient-to-br from-background to-muted/20`}>
        {isLoading && !activity ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-3">
              <ThinkingIndicator size="lg" className="text-primary mx-auto" />
              <p className="text-sm text-muted-foreground">Loading browser activity...</p>
            </div>
          </div>
        ) : currentImageUrl ? (
          <div className="relative w-full h-full">
            {/* Screenshot Display */}
            <div className="relative w-full h-full bg-black/5 flex items-center justify-center">
              <img
                src={currentImageUrl}
                alt="Browser Screenshot"
                className="max-w-full max-h-full object-contain shadow-lg"
                onError={() => setCurrentImageUrl(null)}
              />
            </div>

            {/* Overlay Info */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
              <div className="space-y-2">
                {activity?.message && (
                  <p className="text-white text-sm font-medium">{activity.message}</p>
                )}
                {activity?.currentUrl && (
                  <div className="flex items-center gap-2">
                    <a
                      href={activity.currentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-white/90 text-xs hover:text-white flex items-center gap-1 underline truncate"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {activity.currentUrl}
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full p-8">
            <div className="text-center space-y-3">
              <Monitor className="h-12 w-12 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">
                {activity?.message || 'Waiting for browser activity...'}
              </p>
              {activity?.currentUrl && (
                <a
                  href={activity.currentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline flex items-center justify-center gap-1"
                >
                  <ExternalLink className="h-3 w-3" />
                  {activity.currentUrl}
                </a>
              )}
            </div>
          </div>
        )}

        {/* Screenshot History (if available) */}
        {activity?.screenshots && activity.screenshots.length > 1 && (
          <div className="border-t p-3 bg-muted/30">
            <p className="text-xs font-medium mb-2 text-muted-foreground">Recent Screenshots:</p>
            <div className="flex gap-2 overflow-x-auto">
              {activity.screenshots.slice(-5).map((screenshot, idx) => {
                const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'
                const screenshotUrl = `${apiBaseUrl}/thesis/screenshots/${sessionId}/${screenshot.filename}`
                return (
                  <button
                    key={idx}
                    onClick={() => {
                      setCurrentImageUrl(screenshotUrl)
                    }}
                    className="flex-shrink-0 w-20 h-12 border rounded overflow-hidden hover:border-primary transition"
                  >
                    <img
                      src={screenshotUrl}
                      alt={screenshot.source}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        console.error('Failed to load screenshot:', screenshotUrl)
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

export default BrowserActivityViewer

