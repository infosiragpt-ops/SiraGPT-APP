"use client"

import React, { useState, useEffect } from 'react'
import { BookOpen, Plus, X, CheckCircle, AlertCircle, Download, Search, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { apiClient } from '@/lib/api'
import { toast } from 'sonner'
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

interface ThesisGeneratorProps {
  chatId?: string
  onComplete?: (sessionId: string) => void
}

interface ThesisStatus {
  status: string
  progress: number
  message: string
  error?: string
  documentPath?: string
  documentFilename?: string
  topics?: string[]
  sourcesCount?: number
}

const ThesisGenerator: React.FC<ThesisGeneratorProps> = ({ chatId, onComplete }) => {
  const [topics, setTopics] = useState<string[]>([''])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<ThesisStatus | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isPolling, setIsPolling] = useState(false)
  const [showDialog, setShowDialog] = useState(false)

  // Poll for status updates
  useEffect(() => {
    if (sessionId && isPolling) {
      const interval = setInterval(async () => {
        try {
          const statusData = await apiClient.getThesisStatus(sessionId)
          setStatus(statusData)

          if (statusData.status === 'completed') {
            setIsPolling(false)
            setIsGenerating(false)
            toast.success('Thesis generation completed!')
            if (onComplete) {
              onComplete(sessionId)
            }
          } else if (statusData.status === 'error') {
            setIsPolling(false)
            setIsGenerating(false)
            toast.error(`Error: ${statusData.error || 'Unknown error'}`)
          }
        } catch (error: any) {
          console.error('Error fetching status:', error)
          setIsPolling(false)
        }
      }, 3000) // Poll every 3 seconds

      return () => clearInterval(interval)
    }
  }, [sessionId, isPolling, onComplete])

  const addTopic = () => {
    setTopics([...topics, ''])
  }

  const removeTopic = (index: number) => {
    setTopics(topics.filter((_, i) => i !== index))
  }

  const updateTopic = (index: number, value: string) => {
    const newTopics = [...topics]
    newTopics[index] = value
    setTopics(newTopics)
  }

  const handleGenerate = async () => {
    const validTopics = topics.filter(t => t.trim().length > 0)
    
    if (validTopics.length === 0) {
      toast.error('Please add at least one topic')
      return
    }

    if (validTopics.length < 2) {
      toast.error('Please add at least 2 topics for a comprehensive thesis')
      return
    }

    setIsGenerating(true)
    setShowDialog(true)

    try {
      const response = await apiClient.generateThesis({
        topics: validTopics,
        chatId: chatId
      })

      setSessionId(response.sessionId)
      setIsPolling(true)
      setStatus({
        status: 'initializing',
        progress: 0,
        message: 'Starting thesis generation...',
        topics: validTopics
      })

      toast.success('Thesis generation started!')
    } catch (error: any) {
      console.error('Error generating thesis:', error)
      toast.error(error.message || 'Failed to start thesis generation')
      setIsGenerating(false)
      setShowDialog(false)
    }
  }

  const handleDownload = async () => {
    if (!sessionId) return

    try {
      await apiClient.downloadThesis(sessionId)
      toast.success('Thesis downloaded successfully!')
    } catch (error: any) {
      console.error('Error downloading thesis:', error)
      toast.error('Failed to download thesis')
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-500'
      case 'error':
        return 'bg-red-500'
      case 'generating':
      case 'generating_thesis':
        return 'bg-blue-500'
      default:
        return 'bg-yellow-500'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-500" />
      case 'error':
        return <AlertCircle className="h-5 w-5 text-red-500" />
      default:
        return <ThinkingIndicator size="md" className="text-blue-500" />
    }
  }

  return (
    <div className="w-full space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Thesis Generator
          </CardTitle>
          <CardDescription>
            Enter multiple topics. The system will search different websites, collect research materials, and generate a comprehensive 50+ page thesis document.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Topics Input */}
          <div className="space-y-3">
            <label className="text-sm font-medium">Research Topics</label>
            {topics.map((topic, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  placeholder={`Topic ${index + 1} (e.g., "Artificial Intelligence in Healthcare")`}
                  value={topic}
                  onChange={(e) => updateTopic(index, e.target.value)}
                  className="flex-1"
                />
                {topics.length > 1 && (
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => removeTopic(index)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              onClick={addTopic}
              className="w-full"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Another Topic
            </Button>
          </div>

          {/* Generate Button */}
          <Button
            onClick={handleGenerate}
            disabled={isGenerating || topics.filter(t => t.trim().length > 0).length < 2}
            className="w-full"
            size="lg"
          >
            {isGenerating ? (
              <>
                <ThinkingIndicator size="sm" className="mr-2" />
                Generating...
              </>
            ) : (
              <>
                <Search className="h-4 w-4 mr-2" />
                Generate Thesis
              </>
            )}
          </Button>

          {/* Info Alert */}
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>How it works:</strong>
              <ol className="list-decimal list-inside mt-2 space-y-1 text-sm">
                <li>Searches multiple academic and research websites</li>
                <li>Collects and saves research materials</li>
                <li>Generates a comprehensive thesis using AI</li>
                <li>Saves as a downloadable Word document (50+ pages)</li>
              </ol>
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Status Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {status && getStatusIcon(status.status)}
              Thesis Generation Progress
            </DialogTitle>
            <DialogDescription>
              {status?.topics && (
                <div className="mt-2">
                  <p className="font-medium mb-2">Topics:</p>
                  <div className="flex flex-wrap gap-2">
                    {status.topics.map((topic, idx) => (
                      <Badge key={idx} variant="secondary">{topic}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </DialogDescription>
          </DialogHeader>

          {status && (
            <div className="space-y-4">
              {/* Progress Bar */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Progress</span>
                  <span>{status.progress}%</span>
                </div>
                <Progress value={status.progress} className="h-2" />
              </div>

              {/* Status Message */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Current Status:</p>
                <div className={`p-3 rounded-lg border ${getStatusColor(status.status)}/10 border-current/20`}>
                  <p className="text-sm">{status.message}</p>
                </div>
              </div>

              {/* Stats */}
              {status.sourcesCount !== undefined && (
                <div className="grid grid-cols-2 gap-4">
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-sm text-muted-foreground">Sources Found</p>
                      <p className="text-2xl font-bold">{status.sourcesCount}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="pt-4">
                      <p className="text-sm text-muted-foreground">Topics</p>
                      <p className="text-2xl font-bold">{status.topics?.length || 0}</p>
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* Error Display */}
              {status.error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{status.error}</AlertDescription>
                </Alert>
              )}

              {/* Completion Message */}
              {status.status === 'completed' && (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-800">
                    <p className="font-medium mb-2">Thesis generation completed successfully!</p>
                    <p className="text-sm">Your thesis document is ready for download.</p>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          <DialogFooter>
            {status?.status === 'completed' && (
              <Button onClick={handleDownload} className="w-full">
                <Download className="h-4 w-4 mr-2" />
                Download Thesis
              </Button>
            )}
            {status?.status !== 'completed' && status?.status !== 'error' && (
              <p className="text-sm text-muted-foreground">
                This may take several minutes. You can close this dialog and check back later.
              </p>
            )}
            {(status?.status === 'completed' || status?.status === 'error') && (
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ThesisGenerator

