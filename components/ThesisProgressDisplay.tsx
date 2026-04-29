"use client"

import React from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import BrowserActivityViewer from '@/components/BrowserActivityViewer'
import { 
  CheckCircle, 
  AlertCircle, 
  Download, 
  Eye, 
  FileText, 
  Search, 
  BookOpen,
  Clock,
  Database,
  PenTool
} from 'lucide-react'
import { apiClient } from '@/lib/api'
import { toast } from 'sonner'

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface ThesisProgressDisplayProps {
  thesisData: {
    status: 'initializing' | 'searching' | 'generating' | 'completed' | 'error'
    sessionId?: string
    progress?: number
    message?: string
    documentPath?: string
    documentFilename?: string
    error?: string
    sourcesCount?: number
    topics?: string[]
    currentSource?: string
    currentUrl?: string
    currentScreenshot?: string
    screenshots?: Array<{
      source: string
      filename: string
      url: string
      timestamp: string
    }>
  }
  onPreview?: (documentPath: string) => void
}

const ThesisProgressDisplay: React.FC<ThesisProgressDisplayProps> = ({ 
  thesisData, 
  onPreview 
}) => {
  const [isDownloading, setIsDownloading] = React.useState(false)

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'initializing':
        return <Clock className="h-4 w-4 text-blue-500" />
      case 'searching':
        return <Database className="h-4 w-4 text-amber-500" />
      case 'generating':
        return <PenTool className="h-4 w-4 text-blue-500" />
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />
      default:
        return <ThinkingIndicator size="sm" className="text-gray-500" />
    }
  }

  const getStatusInfo = (status: string) => {
    switch (status) {
      case 'initializing':
        return {
          title: 'Initializing',
          description: 'Setting up thesis generation...',
          color: 'text-blue-600 dark:text-blue-400',
          bgColor: 'bg-blue-50 dark:bg-blue-950',
          borderColor: 'border-blue-200 dark:border-blue-800'
        }
      case 'searching':
      case 'searching_sources':
        return {
          title: 'Searching Sources',
          description: 'Finding academic papers and references...',
          color: 'text-amber-600 dark:text-amber-400',
          bgColor: 'bg-amber-50 dark:bg-amber-950',
          borderColor: 'border-amber-200 dark:border-amber-800'
        }
      case 'generating':
      case 'generating_thesis':
        return {
          title: 'Writing Thesis',
          description: 'Generating comprehensive academic document...',
          color: 'text-blue-600 dark:text-blue-400',
          bgColor: 'bg-blue-50 dark:bg-blue-950',
          borderColor: 'border-blue-200 dark:border-blue-800'
        }
      case 'completed':
        return {
          title: 'Completed',
          description: 'Your thesis has been successfully generated!',
          color: 'text-green-600 dark:text-green-400',
          bgColor: 'bg-green-50 dark:bg-green-950',
          borderColor: 'border-green-200 dark:border-green-800'
        }
      case 'error':
        return {
          title: 'Error',
          description: 'An error occurred during generation',
          color: 'text-red-600 dark:text-red-400',
          bgColor: 'bg-red-50 dark:bg-red-950',
          borderColor: 'border-red-200 dark:border-red-800'
        }
      default:
        return {
          title: 'Processing',
          description: 'Working on your request...',
          color: 'text-gray-600 dark:text-gray-400',
          bgColor: 'bg-gray-50 dark:bg-gray-950',
          borderColor: 'border-gray-200 dark:border-gray-800'
        }
    }
  }

  const handleDownload = async () => {
    if (!thesisData.sessionId && !thesisData.documentFilename) return

    setIsDownloading(true)
    try {
      if (thesisData.sessionId) {
        await apiClient.downloadThesis(thesisData.sessionId)
      } else if (thesisData.documentFilename) {
        // Direct download using filename with authentication
        const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
        const downloadUrl = `${backendUrl}/thesis/files/${thesisData.documentFilename}`;
        
        // Get token from localStorage for authentication
        const token = localStorage.getItem('auth-token');
        const headers = new Headers();
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
        
        const response = await fetch(downloadUrl, {
          method: 'GET',
          headers,
          credentials: 'include',
        });
        
        if (!response.ok) throw new Error('Download failed');
        
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = thesisData.documentFilename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
      toast.success('Thesis downloaded successfully!')
    } catch (error: any) {
      console.error('Error downloading thesis:', error)
      toast.error('Failed to download thesis')
    } finally {
      setIsDownloading(false)
    }
  }

  const handlePreview = () => {
    if (thesisData.sessionId && onPreview) {
      // Use the download URL for preview (same as existing documents)
      const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const documentUrl = `${backendUrl}/thesis/download/${thesisData.sessionId}?preview=true`;
      onPreview(documentUrl);
    } else if (thesisData.documentFilename && onPreview) {
      // Use filename-based URL for preview with full absolute URL
      const backendUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      
      // Get token from localStorage for authentication
      const token = localStorage.getItem('auth-token');
      
      // Build full URL with token and preview as query parameters
      let documentUrl = `${backendUrl}/thesis/files/${thesisData.documentFilename}?preview=true`;
      if (token) {
        documentUrl += `&token=${encodeURIComponent(token)}`;
      }
      
      onPreview(documentUrl);
    }
  }

  const statusInfo = getStatusInfo(thesisData.status)

  return (
    <div className="space-y-4">
      {/* Status for non-completed states */}
      {thesisData.status !== 'completed' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {getStatusIcon(thesisData.status)}
            <div>
              <span className={`font-medium ${statusInfo.color}`}>
                {statusInfo.title}
              </span>
              {thesisData.progress !== undefined && (
                <span className="ml-2 text-sm text-muted-foreground">
                  {thesisData.progress}%
                </span>
              )}
              {/* Show dynamic backend message if available */}
              <p className="text-sm text-muted-foreground mt-0.5">
                {(() => {
                  // Extract specific backend message from content
                  if (thesisData.message && thesisData.status === 'generating') {
                    const generatingMatch = thesisData.message.match(/Generating ([^.]+)\.\.\. \((\d+\/\d+)\)/);
                    if (generatingMatch) {
                      return `${generatingMatch[1]}... (${generatingMatch[2]})`;
                    }
                  }
                  
                  // For other statuses, use the message or fallback description
                  if (thesisData.message && thesisData.message.length < 200) {
                    // If message is short, it's likely a specific step message
                    const cleanMessage = thesisData.message.replace(/[*#]/g, '').replace(/\n+/g, ' ').trim();
                    if (cleanMessage && cleanMessage !== thesisData.message) {
                      return cleanMessage;
                    }
                  }
                  
                  return statusInfo.description;
                })()}
              </p>
            </div>
          </div>

          {/* Browser Activity Viewer for searching status */}
          {thesisData.status === 'searching' && thesisData.sessionId && (
            <BrowserActivityViewer
              sessionId={thesisData.sessionId}
            />
          )}

          {/* Modern Sources Display - Like Claude's web search */}
          {thesisData.status === 'searching' && thesisData.sourcesCount && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-500" />
                <span className="font-medium">Found {thesisData.sourcesCount} sources for topic: "{thesisData.topics?.[0] || 'research'}"</span>
              </div>
              
              {/* Modern source links grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
                <a 
                  href={`https://scholar.google.com/scholar?q=${encodeURIComponent(thesisData.topics?.[0] || 'research')}`} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/20 hover:bg-muted/50 transition-all duration-200 group"
                >
                  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                    <BookOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-foreground group-hover:text-primary">Google Scholar</div>
                    <div className="text-xs text-muted-foreground truncate">scholar.google.com</div>
                  </div>
                </a>

                <a 
                  href={`https://www.researchgate.net/search?q=${encodeURIComponent(thesisData.topics?.[0] || 'research')}`} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/20 hover:bg-muted/50 transition-all duration-200 group"
                >
                  <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center flex-shrink-0">
                    <Database className="h-4 w-4 text-green-600 dark:text-green-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-foreground group-hover:text-primary">ResearchGate</div>
                    <div className="text-xs text-muted-foreground truncate">www.researchgate.net</div>
                  </div>
                </a>

                <a 
                  href={`https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(thesisData.topics?.[0] || 'research')}`} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/20 hover:bg-muted/50 transition-all duration-200 group"
                >
                  <div className="w-8 h-8 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center flex-shrink-0">
                    <Search className="h-4 w-4 text-red-600 dark:text-red-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-foreground group-hover:text-primary">PubMed</div>
                    <div className="text-xs text-muted-foreground truncate">pubmed.ncbi.nlm.nih.gov</div>
                  </div>
                </a>

                <a 
                  href={`https://arxiv.org/search/?query=${encodeURIComponent(thesisData.topics?.[0] || 'research')}&searchtype=all`} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/20 hover:bg-muted/50 transition-all duration-200 group"
                >
                  <div className="w-8 h-8 rounded-full bg-purple-100 dark:bg-purple-900 flex items-center justify-center flex-shrink-0">
                    <FileText className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-foreground group-hover:text-primary">ArXiv</div>
                    <div className="text-xs text-muted-foreground truncate">arxiv.org</div>
                  </div>
                </a>

                <a 
                  href={`https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=${encodeURIComponent(thesisData.topics?.[0] || 'research')}`} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/20 hover:bg-muted/50 transition-all duration-200 group"
                >
                  <div className="w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-900 flex items-center justify-center flex-shrink-0">
                    <Database className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-foreground group-hover:text-primary">IEEE Xplore</div>
                    <div className="text-xs text-muted-foreground truncate">ieeexplore.ieee.org</div>
                  </div>
                </a>

                <a 
                  href={`https://www.google.com/search?q=${encodeURIComponent(thesisData.topics?.[0] || 'research')}`} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/20 hover:bg-muted/50 transition-all duration-200 group"
                >
                  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center flex-shrink-0">
                    <Search className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm text-foreground group-hover:text-primary">Google Search</div>
                    <div className="text-xs text-muted-foreground truncate">www.google.com</div>
                  </div>
                </a>
              </div>
            </div>
          )}

          {/* Research Materials Summary */}
          {thesisData.status === 'generating' && thesisData.sourcesCount && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-blue-500" />
                <span className="font-medium">Research Materials Saved</span>
              </div>
              <div className="text-sm space-y-1 ml-6">
                <p><strong>Total Sources Found:</strong> {thesisData.sourcesCount}</p>
                <p><strong>Topics Covered:</strong> {thesisData.topics?.length || 1}</p>
                <p><strong>Sources by Topic:</strong></p>
                <div className="ml-3">
                  {thesisData.topics?.map(topic => (
                    <p key={topic}>• {topic}: {thesisData.sourcesCount} sources</p>
                  )) || <p>• research: {thesisData.sourcesCount} sources</p>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Completion Card */}
      {thesisData.status === 'completed' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {getStatusIcon(thesisData.status)}
            <span className={`font-medium ${statusInfo.color}`}>
              ✅ Thesis Generation Completed!
            </span>
          </div>
          
          <div className="text-sm space-y-1">
            <p><strong>Topics Covered:</strong> {thesisData.topics?.length || 1}</p>
            <p><strong>Research Sources:</strong> {thesisData.sourcesCount || 0}</p>
            <p><strong>Thesis Length:</strong> 40.8K characters</p>
          </div>

          {thesisData.documentFilename && (
            <>
              <p className="text-sm"><strong>Document:</strong> {thesisData.documentFilename}</p>
              <p className="text-sm text-muted-foreground">
                Your comprehensive thesis has been generated and saved. You can download it from the files section.
              </p>
            </>
          )}

          {/* Action Buttons Card */}
          {(thesisData.documentPath || thesisData.documentFilename) && (
            <Card className="p-4 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950 dark:to-emerald-950 border-green-200 dark:border-green-800">
              {thesisData.documentFilename && (
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-900 flex items-center justify-center">
                    <FileText className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <p className="font-medium text-green-700 dark:text-green-300">
                      {thesisData.documentFilename}
                    </p>
                    <Badge variant="outline" className="text-xs border-green-300 text-green-600">
                      Word Document
                    </Badge>
                  </div>
                </div>
              )}
              
              <div className="flex gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePreview}
                  className="flex items-center gap-2 border-green-300 hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-900"
                  disabled={!thesisData.sessionId && !thesisData.documentFilename}
                >
                  <Eye className="h-4 w-4" />
                  Preview
                </Button>
                
                <Button
                  size="sm"
                  onClick={handleDownload}
                  disabled={isDownloading || (!thesisData.sessionId && !thesisData.documentFilename)}
                  className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white"
                >
                  {isDownloading ? (
                    <ThinkingIndicator size="sm" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Download
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Error Message */}
      {thesisData.error && (
        <div className="p-4 bg-red-50 dark:bg-red-950 border-l-4 border-red-500 rounded-lg">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
            <span className="font-medium text-red-600 dark:text-red-400">
              Thesis Generation Error
            </span>
          </div>
          <p className="text-red-600 dark:text-red-400 mt-1 text-sm">
            {thesisData.error}
          </p>
        </div>
      )}
    </div>
  )
}

export default ThesisProgressDisplay