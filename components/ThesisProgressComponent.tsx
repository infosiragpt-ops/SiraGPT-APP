"use client"

import React, { useState } from 'react'
import { CheckCircle, AlertCircle, Download, FileText, Search, Clock, BookOpen, Eye } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
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
} from '@/components/ui/dialog'

interface ThesisData {
  sessionId: string
  status: 'initializing' | 'searching' | 'generating' | 'completed' | 'error'
  progress: number
  message: string
  topics: string[]
  sourcesCount?: number
  documentPath?: string
  documentFilename?: string
  error?: string
}

interface ThesisProgressComponentProps {
  thesisData: ThesisData
  className?: string
}

const ThesisProgressComponent: React.FC<ThesisProgressComponentProps> = ({ 
  thesisData, 
  className = "" 
}) => {
  const [isDownloading, setIsDownloading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-500'
      case 'error':
        return 'bg-red-500'
      case 'generating':
        return 'bg-blue-500'
      case 'searching':
        return 'bg-yellow-500'
      default:
        return 'bg-gray-500'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-500" />
      case 'error':
        return <AlertCircle className="h-5 w-5 text-red-500" />
      case 'searching':
        return <Search className="h-5 w-5 text-yellow-500 animate-pulse" />
      case 'generating':
        return <FileText className="h-5 w-5 text-blue-500 animate-pulse" />
      default:
        return <ThinkingIndicator size="md" className="text-gray-500" />
    }
  }

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'initializing':
        return 'Initializing'
      case 'searching':
        return 'Searching Sources'
      case 'generating':
        return 'Generating Thesis'
      case 'completed':
        return 'Completed'
      case 'error':
        return 'Error'
      default:
        return 'Processing'
    }
  }

  const handleDownload = async () => {
    if (!thesisData.sessionId) return

    setIsDownloading(true)
    try {
      await apiClient.downloadThesis(thesisData.sessionId)
      toast.success('Thesis downloaded successfully!')
    } catch (error: any) {
      console.error('Error downloading thesis:', error)
      toast.error('Failed to download thesis')
    } finally {
      setIsDownloading(false)
    }
  }

  const handlePreview = () => {
    setShowPreview(true)
  }

  return (
    <>
      <Card className={`w-full ${className}`}>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              <span>Thesis Generation</span>
            </div>
            <Badge variant={thesisData.status === 'completed' ? 'default' : 'secondary'} className="text-xs">
              {getStatusLabel(thesisData.status)}
            </Badge>
          </CardTitle>
        </CardHeader>
        
        <CardContent className="space-y-4">
          {/* Topics */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Topics:</p>
            <div className="flex flex-wrap gap-1">
              {thesisData.topics.map((topic, idx) => (
                <Badge key={idx} variant="outline" className="text-xs">{topic}</Badge>
              ))}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="flex items-center gap-2">
                {getStatusIcon(thesisData.status)}
                Progress
              </span>
              <span>{thesisData.progress}%</span>
            </div>
            <Progress value={thesisData.progress} className="h-2" />
          </div>

          {/* Status Message */}
          <div className={`p-3 rounded-lg border ${getStatusColor(thesisData.status)}/10 border-current/20`}>
            <p className="text-sm">{thesisData.message}</p>
          </div>

          {/* Stats */}
          {(thesisData.sourcesCount !== undefined || thesisData.status === 'completed') && (
            <div className="grid grid-cols-2 gap-3">
              {thesisData.sourcesCount !== undefined && (
                <div className="bg-gray-50 p-3 rounded-lg">
                  <p className="text-xs text-muted-foreground">Sources Found</p>
                  <p className="text-lg font-bold">{thesisData.sourcesCount}</p>
                </div>
              )}
              <div className="bg-gray-50 p-3 rounded-lg">
                <p className="text-xs text-muted-foreground">Topics</p>
                <p className="text-lg font-bold">{thesisData.topics.length}</p>
              </div>
            </div>
          )}

          {/* Error Display */}
          {thesisData.error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-sm">{thesisData.error}</AlertDescription>
            </Alert>
          )}

          {/* Completion Actions */}
          {thesisData.status === 'completed' && (
            <div className="space-y-2">
              <Alert className="bg-green-50 border-green-200">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-800 text-sm">
                  <p className="font-medium mb-1">Thesis generation completed successfully!</p>
                  <p className="text-xs">Your comprehensive thesis document is ready for download.</p>
                </AlertDescription>
              </Alert>
              
              <div className="flex gap-2">
                <Button 
                  onClick={handleDownload} 
                  disabled={isDownloading}
                  className="flex-1"
                  size="sm"
                >
                  {isDownloading ? (
                    <>
                      <ThinkingIndicator size="sm" className="mr-2" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4 mr-2" />
                      Download (.docx)
                    </>
                  )}
                </Button>
                
                {thesisData.documentPath && (
                  <Button 
                    onClick={handlePreview}
                    variant="outline"
                    size="sm"
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    Preview
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Processing Info */}
          {thesisData.status !== 'completed' && thesisData.status !== 'error' && (
            <div className="bg-blue-50 p-3 rounded-lg">
              <div className="flex items-center gap-2 text-blue-800">
                <Clock className="h-4 w-4" />
                <p className="text-xs font-medium">
                  This process may take 5-15 minutes depending on topic complexity.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preview Dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Thesis Preview</DialogTitle>
            <DialogDescription>
              Preview of your generated thesis document
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="bg-gray-50 p-4 rounded-lg">
              <h3 className="font-medium mb-2">Topics Covered:</h3>
              <div className="flex flex-wrap gap-1">
                {thesisData.topics.map((topic, idx) => (
                  <Badge key={idx} variant="outline">{topic}</Badge>
                ))}
              </div>
            </div>
            
            {thesisData.documentFilename && (
              <div className="bg-gray-50 p-4 rounded-lg">
                <h3 className="font-medium mb-2">Document Info:</h3>
                <p className="text-sm text-gray-600">Filename: {thesisData.documentFilename}</p>
                <p className="text-sm text-gray-600">Status: Ready for download</p>
              </div>
            )}
            
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowPreview(false)}>
                Close
              </Button>
              <Button onClick={handleDownload} disabled={isDownloading}>
                {isDownloading ? (
                  <>
                    <ThinkingIndicator size="sm" className="mr-2" />
                    Downloading...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default ThesisProgressComponent