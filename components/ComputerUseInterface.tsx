"use client"

import React, { useState, useEffect, useRef } from 'react'
import { 
  Play, 
  Square, 
  Monitor, 
  AlertTriangle, 
  CheckCircle, 
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  Bot,
  Settings
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogFooter, 
  DialogHeader, 
  DialogTitle 
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from 'sonner'
import ComputerUseSettings from './ComputerUseSettings'

interface ComputerUseInterfaceProps {
  task: string
  onStatusChange?: (status: 'idle' | 'running' | 'completed' | 'error') => void
  onScreenshotUpdate?: (screenshot: string) => void
  autoStart?: boolean
  chatId?: string
}

interface SafetyCheck {
  id: string
  code: string
  message: string
}

interface ReasoningStep {
  text: string
  timestamp: number
  action?: string
}

const ComputerUseInterface: React.FC<ComputerUseInterfaceProps> = ({ 
  task, 
  onStatusChange,
  onScreenshotUpdate,
  autoStart = false,
  chatId
}) => {
  // State management
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'error'>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [reasoning, setReasoning] = useState<ReasoningStep[]>([])
  const [safetyChecks, setSafetyChecks] = useState<SafetyCheck[]>([])
  const [showSafetyDialog, setShowSafetyDialog] = useState(false)
  const [pendingCallId, setPendingCallId] = useState<string | null>(null)
  const [isVisible, setIsVisible] = useState(true)
  
  // WebSocket connection
  const wsRef = useRef<WebSocket | null>(null)
  const reasoningEndRef = useRef<HTMLDivElement>(null)

  // Generate unique session ID
  const generateSessionId = () => {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  // Connect to WebSocket
  const connectWebSocket = (sessionId: string) => {
    // Prefer an explicit backend URL if provided, otherwise default to localhost:5000
    const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000')

    const candidateWsUrls = [
      backendUrl.replace(/^http/, 'ws') + '/ws/computer-use',
      // Fallback to localhost backend if the configured URL points to the frontend dev server
      'ws://localhost:5000/ws/computer-use'
    ]

    let connected = false
    let tried = 0

    const tryConnect = (url: string) => {
      tried++
      console.log(`Attempting WebSocket connection to ${url}`)
      const ws = new WebSocket(url)
      let opened = false

      const cleanup = () => {
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
      }

      ws.onopen = () => {
        opened = true
        connected = true
        wsRef.current = ws
        console.log('Computer Use WebSocket connected to', url)
        ws.send(JSON.stringify({ type: 'join-session', sessionId }))
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          handleWebSocketMessage(data)
        } catch (error) {
          console.error('WebSocket message parsing error:', error)
        }
      }

      ws.onclose = (ev) => {
        cleanup()
        if (!opened && tried < candidateWsUrls.length) {
          // Try next candidate
          tryConnect(candidateWsUrls[tried])
        } else {
          console.log('Computer Use WebSocket disconnected')
          if (!connected) {
            toast.error('Unable to connect to Computer Use server. Make sure backend is running on port 5000.')
          }
        }
      }

      ws.onerror = (error) => {
        console.error('WebSocket error connecting to', url, error)
        // onerror will be followed by onclose which triggers retry
      }
    }

    // Start first attempt
    tryConnect(candidateWsUrls[0])
  }

  // Handle WebSocket messages
  const handleWebSocketMessage = (data: any) => {
    switch (data.type) {
      case 'session-started':
        setScreenshot(data.data.initialScreenshot)
        onScreenshotUpdate?.(data.data.initialScreenshot)
        addReasoning('Session started, analyzing task...')
        break
        
      case 'reasoning':
        addReasoning(data.data.reasoning, data.data.action)
        break
        
      case 'screenshot':
        setScreenshot(data.data.image)
        onScreenshotUpdate?.(data.data.image)
        break
        
      case 'safety-check':
        setSafetyChecks(data.data.checks)
        setPendingCallId(data.data.callId)
        setShowSafetyDialog(true)
        addReasoning('⚠️ Safety check required - pausing for user confirmation')
        break
        
      case 'task-completed':
        setStatus('completed')
        onStatusChange?.('completed')
        setScreenshot(data.data.finalScreenshot)
        onScreenshotUpdate?.(data.data.finalScreenshot)
        addReasoning('✅ Task completed successfully!')
        toast.success('Computer Use task completed!')
        break
        
      case 'session-stopped':
        setStatus('idle')
        onStatusChange?.('idle')
        addReasoning('🛑 Session stopped by user')
        break
        
      case 'error':
        setStatus('error')
        onStatusChange?.('error')
        addReasoning(`❌ Error: ${data.data.error}`)
        toast.error(`Computer Use error: ${data.data.error}`)
        break
        
      default:
        console.log('Unknown message type:', data.type)
    }
  }

  // Add reasoning step
  const addReasoning = (text: string, action?: string) => {
    const newStep: ReasoningStep = {
      text,
      timestamp: Date.now(),
      action
    }
    setReasoning(prev => [...prev, newStep])
  }

  // Start Computer Use session
  const startSession = async () => {
    if (!task.trim()) {
      toast.error('Please provide a task description')
      return
    }
    setStatus('running')
    onStatusChange?.('running')
    setReasoning([])
    setScreenshot(null)

    const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'

    // If this component was opened from a chat integration, ask the server to create/start the session
    if (autoStart && chatId) {
      try {
        // Request server to start a session tied to this chat and return the sessionId
        const resp = await fetch(`${baseUrl}/computer-use/chat-integration`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: task, chatId })
        })

        const data = await resp.json()
        if (!data.success) throw new Error(data.error || 'Failed to start chat-integrated session')

        const serverSessionId = data.sessionId || `chat-${chatId}-${Date.now()}`
        setSessionId(serverSessionId)
        // Connect WebSocket to the server session
        connectWebSocket(serverSessionId)
        toast.success('Computer Use session started (chat-integrated)')
      } catch (err: any) {
        console.error('Error starting chat-integrated session:', err)
        setStatus('error')
        onStatusChange?.('error')
        toast.error('Failed to start Computer Use session (chat)')
      }

      return
    }

    // Default standalone start flow
    const newSessionId = generateSessionId()
    setSessionId(newSessionId)
    connectWebSocket(newSessionId)

    try {
      const response = await fetch(`${baseUrl}/computer-use/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ task, sessionId: newSessionId })
      })

      const result = await response.json()
      if (!result.success) throw new Error(result.error || 'Failed to start session')

      toast.success('Computer Use session started!')
    } catch (error) {
      console.error('Error starting session:', error)
      setStatus('error')
      onStatusChange?.('error')
      toast.error('Failed to start Computer Use session')
    }
  }

  // Stop Computer Use session
  const stopSession = async () => {
    if (!sessionId) return
    
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'
      await fetch(`${baseUrl}/api/computer-use/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId })
      })
      
      setStatus('idle')
      onStatusChange?.('idle')
      setSessionId(null)
      
      // Close WebSocket
      wsRef.current?.close()
      
    } catch (error) {
      console.error('Error stopping session:', error)
      toast.error('Failed to stop session')
    }
  }

  // Acknowledge safety checks
  const acknowledgeSafetyChecks = async (acknowledged: boolean) => {
    if (!sessionId || !pendingCallId) return
    
    try {
      if (acknowledged) {
        const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000'
        await fetch(`${baseUrl}/computer-use/acknowledge-safety`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sessionId,
            callId: pendingCallId,
            acknowledgedChecks: safetyChecks
          })
        })
        
        addReasoning('✅ Safety checks acknowledged - continuing task')
        toast.success('Safety checks acknowledged')
      } else {
        await stopSession()
        addReasoning('🛑 Task cancelled due to safety concerns')
        toast.info('Task cancelled for safety reasons')
      }
      
      setShowSafetyDialog(false)
      setSafetyChecks([])
      setPendingCallId(null)
      
    } catch (error) {
      console.error('Error handling safety checks:', error)
      toast.error('Failed to handle safety checks')
    }
  }

  // Auto-scroll reasoning
  useEffect(() => {
    reasoningEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [reasoning])

  // Auto-start if enabled
  useEffect(() => {
    if (autoStart && task && status === 'idle') {
      startSession()
    }
  }, [autoStart, task])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wsRef.current?.close()
    }
  }, [])

  return (
    <div className="w-full h-full flex flex-col">
      {/* Controls */}
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Monitor className="h-5 w-5" />
              Computer Use Agent
            </CardTitle>
            <div className="flex items-center gap-2">
              <ComputerUseSettings 
                onSettingsChange={(settings) => console.log('Settings updated:', settings)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsVisible(!isVisible)}
              >
                {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                {isVisible ? 'Hide' : 'Show'}
              </Button>
              <Badge variant={
                status === 'running' ? 'default' : 
                status === 'completed' ? 'secondary' : 
                status === 'error' ? 'destructive' : 'outline'
              }>
                {status}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Button
              onClick={startSession}
              disabled={status === 'running'}
              className="flex items-center gap-2"
            >
              {status === 'running' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Start Task
            </Button>
            
            {status === 'running' && (
              <Button
                onClick={stopSession}
                variant="destructive"
                className="flex items-center gap-2"
              >
                <Square className="h-4 w-4" />
                Stop
              </Button>
            )}
          </div>
          
          {task && (
            <div className="mt-3 p-3 bg-muted rounded-lg">
              <p className="text-sm"><strong>Task:</strong> {task}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {isVisible && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0">
          {/* Browser Preview */}
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Live Browser View</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0">
              <div className="h-full bg-muted rounded-lg overflow-hidden">
                {screenshot ? (
                  <img
                    src={screenshot}
                    alt="Computer Use Screenshot"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <Monitor className="h-12 w-12 mx-auto mb-2" />
                      <p>Browser view will appear here</p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Reasoning Steps */}
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Bot className="h-5 w-5" />
                AI Reasoning
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0">
              <ScrollArea className="h-full p-4">
                <div className="space-y-3">
                  {reasoning.map((step, index) => (
                    <div key={index} className="flex gap-3">
                      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">
                        {index + 1}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm">{step.text}</p>
                        {step.action && (
                          <Badge variant="outline" className="mt-1 text-xs">
                            {step.action}
                          </Badge>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          {new Date(step.timestamp).toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  ))}
                  <div ref={reasoningEndRef} />
                </div>
                
                {reasoning.length === 0 && (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <Bot className="h-12 w-12 mx-auto mb-2" />
                      <p>AI reasoning will appear here</p>
                    </div>
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Safety Check Dialog */}
      <Dialog open={showSafetyDialog} onOpenChange={setShowSafetyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              Safety Check Required
            </DialogTitle>
            <DialogDescription>
              The AI has detected potential safety concerns and requires your approval to continue.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-3">
            {safetyChecks.map((check, index) => (
              <Alert key={index}>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <strong>{check.code}:</strong> {check.message}
                </AlertDescription>
              </Alert>
            ))}
          </div>
          
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => acknowledgeSafetyChecks(false)}
            >
              <XCircle className="h-4 w-4 mr-2" />
              Cancel Task
            </Button>
            <Button
              onClick={() => acknowledgeSafetyChecks(true)}
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              Acknowledge & Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ComputerUseInterface