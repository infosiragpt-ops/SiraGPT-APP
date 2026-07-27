import { useState, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { getNormalizedApiBaseUrl } from '@/lib/api'
import { authenticatedFetch } from '@/lib/authenticated-fetch'
import { devLog } from '@/lib/dev-log'

interface ReasoningStep {
  text: string
  timestamp: number
  action?: string
}

interface ExtractedData {
  success: boolean
  url: string
  title: string
  extractedInfo: string
  rawContent: string
  metaData: any
  timestamp: string
  userQuery: string
  error?: string
}

interface ComputerUseHookReturn {
  status: 'idle' | 'running' | 'completed' | 'error'
  screenshot: string | null
  reasoning: ReasoningStep[]
  extractedData: ExtractedData | null
  finalUrl: string | null
  startComputerUse: (task: string, chatId?: string, userId?: string, mode?: 'browser' | 'chrome' | 'computer') => Promise<void>
  stopComputerUse: () => Promise<void>
  addReasoningStep: (text: string, action?: string) => void
  clearReasoning: () => void
}

export const useComputerUse = (): ComputerUseHookReturn => {
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'error'>('idle')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [reasoning, setReasoning] = useState<ReasoningStep[]>([])
  const [extractedData, setExtractedData] = useState<ExtractedData | null>(null)
  const [finalUrl, setFinalUrl] = useState<string | null>(null)
  const [pendingCallId, setPendingCallId] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)

  // Generate unique session ID
  const generateSessionId = useCallback(() => {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }, [])

  // Add reasoning step
  const addReasoningStep = useCallback((text: string, action?: string) => {
    const newStep: ReasoningStep = {
      text,
      timestamp: Date.now(),
      action
    }
    setReasoning(prev => [...prev, newStep])
  }, [])

  // Clear reasoning
  const clearReasoning = useCallback(() => {
    setReasoning([])
    setExtractedData(null)
    setFinalUrl(null)
  }, [])

  // Handle WebSocket messages
  const handleWebSocketMessage = useCallback((data: any) => {
    switch (data.type) {
      case 'session-started':
        setScreenshot(data.data.initialScreenshot)
        addReasoningStep('Session started, analyzing task...')
        break

      case 'reasoning':
        addReasoningStep(data.data.reasoning, data.data.action)
        break

      case 'screenshot':
        setScreenshot(data.data.image)
        break

      case 'task-completed':
        setStatus('completed')
        setScreenshot(data.data.finalScreenshot)
        if (data.data.extractedData) {
          setExtractedData(data.data.extractedData)
          devLog('Extracted data received:', data.data.extractedData)
        }
        if (data.data.finalUrl) {
          setFinalUrl(data.data.finalUrl)
        }
        const completionMessage = data.data.extractedData?.success
          ? '\u2705 Task completed! Relevant information extracted and saved to chat.'
          : '\u2705 Task completed successfully!'
        addReasoningStep(completionMessage)
        toast.success('Computer Use task completed!')

        // If extraction was successful, trigger a chat refresh
        if (data.data.extractedData?.success) {
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('computer-use-extraction-complete', {
              detail: { extractedData: data.data.extractedData }
            }));
          }, 1000);
        }
        break

      case 'extraction-completed':
        // Handle extraction completion broadcast from backend
        devLog('Extraction completed event received');
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('computer-use-extraction-complete', {
            detail: { chatId: data.data.chatId }
          }));
        }, 500);
        break

      case 'session-stopped':
        setStatus('idle')
        addReasoningStep('🛑 Session stopped by user')
        break

      case 'error':
        setStatus('error')
        addReasoningStep(`❌ Error: ${data.data.error}`)
        toast.error(`Computer Use error: ${data.data.error}`)
        break

      default:
        devLog('Unknown message type:', data.type)
    }
  }, [addReasoningStep])

  // Connect to WebSocket
  const connectWebSocket = useCallback((sessionId: string) => {
    const apiBaseUrl = getNormalizedApiBaseUrl()
    const backendUrl = apiBaseUrl.replace(/\/api$/, '')
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth-token') : null

    // const candidateWsUrls = [
    //   backendUrl.replace(/^http/, 'ws') + '/ws/computer-use',
    //   'ws://localhost:5000/ws/computer-use'
    // ]
    const candidateWsUrls = [
      backendUrl.replace(/^http/, 'ws') + '/ws/computer-use'
    ]

    let connected = false
    let tried = 0

    const tryConnect = (url: string) => {
      tried++
      devLog(`Attempting WebSocket connection to ${url}`)
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
        // Store WebSocket globally for chat interface to access
        if (typeof window !== 'undefined') {
          (window as any).computerUseWebSocket = ws
        }
        devLog('Computer Use WebSocket connected to', url)
        ws.send(JSON.stringify({ type: 'join-session', sessionId, token }))
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
          tryConnect(candidateWsUrls[tried])
        } else {
          devLog('Computer Use WebSocket disconnected')
          if (!connected) {
            toast.error('Unable to connect to Computer Use server. Make sure backend is running on port 5000.')
          }
        }
      }

      ws.onerror = (error) => {
        console.error('WebSocket error connecting to', url, error)
      }
    }

    tryConnect(candidateWsUrls[0])
  }, [handleWebSocketMessage])

  // Start Computer Use session
  const startComputerUse = useCallback(async (task: string, chatId?: string, userId?: string, mode: 'browser' | 'chrome' | 'computer' = 'browser') => {
    if (!task.trim()) {
      toast.error('Please provide a task description')
      return
    }

    const baseUrl = getNormalizedApiBaseUrl()

    setStatus('running')
    clearReasoning()
    setScreenshot(null)

    const headers = {
      'Content-Type': 'application/json',
    }

    try {
      if (chatId) {
        // Chat-integrated session
        const resp = await authenticatedFetch(`${baseUrl}/computer-use/chat-integration`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: task, chatId, mode })
        })

        const data = await resp.json()
        if (!data.success) throw new Error(data.error || 'Failed to start chat-integrated session')

        const serverSessionId = data.sessionId || `chat-${chatId}-${Date.now()}`
        setSessionId(serverSessionId)
        connectWebSocket(serverSessionId)
        toast.success('Computer Use session started')
      } else {
        // Standalone session
        const newSessionId = generateSessionId()
        setSessionId(newSessionId)
        connectWebSocket(newSessionId)

        const response = await authenticatedFetch(`${baseUrl}/computer-use/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ task, sessionId: newSessionId, mode })
        })

        const result = await response.json()
        if (!result.success) throw new Error(result.error || 'Failed to start session')

        toast.success('Computer Use session started!')
      }
    } catch (error) {
      console.error('Error starting session:', error)
      setStatus('error')
      toast.error('Failed to start Computer Use session')
    }
  }, [generateSessionId, connectWebSocket, clearReasoning])

  // Stop Computer Use session
  const stopComputerUse = useCallback(async () => {
    if (!sessionId) return

    try {
      const baseUrl = getNormalizedApiBaseUrl()
      await authenticatedFetch(`${baseUrl}/computer-use/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId })
      })

      setStatus('idle')
      setSessionId(null)
      wsRef.current?.close()

    } catch (error) {
      console.error('Error stopping session:', error)
      toast.error('Failed to stop session')
    }
  }, [sessionId])

  return {
    status,
    screenshot,
    reasoning,
    extractedData,
    finalUrl,
    startComputerUse,
    stopComputerUse,
    addReasoningStep,
    clearReasoning
  }
}

export default useComputerUse
