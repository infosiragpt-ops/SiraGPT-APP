"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import {
  Video,
  Play,
  Pause,
  Download,
  Volume2,
  Clock,
  Sparkles,
  Monitor,
  Smartphone,
  Square,
  Film,
  Maximize2,
  CheckCircle,
  AlertCircle,
  XCircle,
  Timer,
  RefreshCw
} from "lucide-react"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface VideoOperation {
  operationId: string;
  filename: string;
  status: 'processing' | 'completed' | 'failed' | 'timeout';
  prompt: string;
  duration: string;
  aspect_ratio: string;
  error?: string;
  result?: {
    video_url: string;
    download_url: string;
    filename: string;
    duration: string;
    file_size: number;
    width?: number;
    height?: number;
  };
  estimatedTime?: string;
  createdAt: string;
  updatedAt?: string;
  queuePosition?: number;
}

interface GeneratedVideo {
  video_url: string;
  download_url?: string;
  filename: string;
  duration: string;
  prompt: string;
  aspect_ratio: string;
  status: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export default function VideoGenerationComponent() {
  const [prompt, setPrompt] = React.useState("")
  const [aspectRatio, setAspectRatio] = React.useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [negativePrompt, setNegativePrompt] = React.useState("")
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [currentOperation, setCurrentOperation] = React.useState<VideoOperation | null>(null)
  const [generatedVideo, setGeneratedVideo] = React.useState<GeneratedVideo | null>(null)
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [totalDuration, setTotalDuration] = React.useState(0)
  const [volume, setVolume] = React.useState([0.8])
  const [isFullscreen, setIsFullscreen] = React.useState(false)

  const videoRef = React.useRef<HTMLVideoElement>(null)
  const pollIntervalRef = React.useRef<NodeJS.Timeout | null>(null)

  React.useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
      }
    }
  }, [])

  React.useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const updateTime = () => setCurrentTime(video.currentTime)
    const updateDuration = () => setTotalDuration(video.duration)
    const handleEnded = () => setIsPlaying(false)

    video.addEventListener('timeupdate', updateTime)
    video.addEventListener('loadedmetadata', updateDuration)
    video.addEventListener('ended', handleEnded)

    return () => {
      video.removeEventListener('timeupdate', updateTime)
      video.removeEventListener('loadedmetadata', updateDuration)
      video.removeEventListener('ended', handleEnded)
    }
  }, [generatedVideo])

  React.useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.volume = volume[0]
    }
  }, [volume])

  const startPolling = (operationId: string) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
    }

    pollIntervalRef.current = setInterval(async () => {
      try {
        const response = await apiClient.getVideoStatus(operationId)
        setCurrentOperation(response)

        if (response.status === 'completed') {
          clearInterval(pollIntervalRef.current!)
          pollIntervalRef.current = null

          if (response.result) {
            setGeneratedVideo({
              video_url: response.result.video_url,
              download_url: response.result.download_url,
              filename: response.result.filename,
              duration: response.result.duration || "8s",
              prompt: response.prompt,
              aspect_ratio: response.aspect_ratio,
              status: 'completed',
              width: response.result.width,
              height: response.result.height,
              file_size: response.result.file_size
            })
            toast.success('Video generated successfully! 🎬')
          }
          setIsGenerating(false)
        } else if (response.status === 'failed' || response.status === 'timeout') {
          clearInterval(pollIntervalRef.current!)
          pollIntervalRef.current = null
          setIsGenerating(false)

          if (response.status === 'failed') {
            toast.error(`Video generation failed: ${response.error || 'Unknown error'}`)
          } else {
            toast.error('Video generation timed out. Please try again with a simpler prompt.')
          }
        }
      } catch (error) {
        console.error('Error polling video status:', error)
      }
    }, 3000) // Poll every 3 seconds
  }

  const generateVideo = async () => {
    if (!prompt.trim()) {
      toast.error('Please enter a video description')
      return
    }

    setIsGenerating(true)
    setCurrentOperation(null)
    setGeneratedVideo(null)

    try {
      const response = await apiClient.generateVideo({
        prompt: prompt,
        aspect_ratio: aspectRatio,
        negative_prompt: negativePrompt.trim() ? negativePrompt : undefined
      })

      if (response.success) {
        setCurrentOperation({
          operationId: response.operationId,
          filename: response.filename,
          status: 'processing',
          prompt: response.prompt || prompt,
          duration: response.duration || "8s",
          aspect_ratio: response.aspect_ratio || aspectRatio,
          estimatedTime: response.estimatedTime,
          createdAt: new Date().toISOString()
        })

        toast.success('Video generation started! This may take 2-5 minutes.')
        startPolling(response.operationId)
      } else {
        toast.error(response.error || 'Failed to start video generation')
        setIsGenerating(false)
      }
    } catch (error: any) {
      console.error('Video generation error:', error)
      setIsGenerating(false)

      if (error.message?.includes('quota') || error.message?.includes('429')) {
        toast.error('API quota exceeded. Please try again later.')
      } else if (error.message?.includes('401') || error.message?.includes('403')) {
        toast.error('Invalid API key. Please check your configuration.')
      } else if (error.message?.includes('422')) {
        toast.error('Invalid parameters. Please check your input.')
      } else {
        toast.error('Failed to generate video. Please try again.')
      }
    }
  }

  const togglePlayPause = () => {
    const video = videoRef.current
    if (!video) return

    if (isPlaying) {
      video.pause()
    } else {
      video.play()
    }
    setIsPlaying(!isPlaying)
  }

  const toggleFullscreen = () => {
    const video = videoRef.current
    if (!video) return

    if (!isFullscreen) {
      if (video.requestFullscreen) {
        video.requestFullscreen()
        setIsFullscreen(true)
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen()
        setIsFullscreen(false)
      }
    }
  }

  // Download video function

  const downloadVideo = async () => {
    if (!generatedVideo) return

    try {
      // Use the download endpoint that forces file download
      const downloadUrl = generatedVideo.download_url
        ? `${apiClient.apiBaseURL}${generatedVideo.download_url}`
        : `${apiClient.apiBaseURL}/video/download/${generatedVideo.filename}`

      console.log('📥 Starting download from:', downloadUrl)

      // Try to fetch the file first to check if it exists
      const response = await fetch(downloadUrl, { method: 'HEAD' })

      if (!response.ok) {
        toast.error('Video file not found or not ready for download')
        return
      }

      // Create a temporary link and click it to trigger download
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = generatedVideo.filename
      link.style.display = 'none'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)

      toast.success('Video download started')
    } catch (error) {
      console.error('Download error:', error)
      toast.error('Failed to download video. Please try again.')
    }
  }

  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.floor(seconds % 60)
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
  }

  const getAspectRatioIcon = (ratio: string) => {
    switch (ratio) {
      case '16:9': return <Monitor className="h-4 w-4" />
      case '9:16': return <Smartphone className="h-4 w-4" />
      case '1:1': return <Square className="h-4 w-4" />
      default: return <Monitor className="h-4 w-4" />
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'processing': return <ThinkingIndicator size="sm" className="text-blue-500" />
      case 'completed': return <CheckCircle className="h-4 w-4 text-green-500" />
      case 'failed': return <XCircle className="h-4 w-4 text-red-500" />
      case 'timeout': return <Timer className="h-4 w-4 text-orange-500" />
      default: return <AlertCircle className="h-4 w-4 text-gray-500" />
    }
  }

  const suggestedPrompts = [
    "A cinematic drone shot of an eagle soaring gracefully above snow-capped mountains at sunrise, golden light reflecting on its wings",
    "Ultra slow-motion footage of vibrant paints splashing and blending together on a black background, creating a mesmerizing abstract pattern",
    "A warm, cozy coffee shop interior with sunlight streaming through the window, steam rising gently from a freshly brewed cup on a wooden table",
    "The northern lights shimmering across a starry arctic sky, reflecting beautifully on a frozen lake surrounded by pine trees",
    "A futuristic cyberpunk city street at night, filled with glowing neon signs and rain-soaked pavement reflecting vivid colors",
    "Massive ocean waves crashing against dramatic rocky cliffs, filmed in cinematic slow motion with water spray captured in detail",
    "A delicate rose blooming in stunning time-lapse, petals unfolding slowly with drops of morning dew sparkling in the sunlight",
    "Abstract 3D geometric shapes floating in space, smoothly morphing and shifting colors in rhythm with invisible music beats"
  ];


  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold flex items-center justify-center gap-2">
          <Video className="h-5 w-5" />
          AI Video Generation
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Create stunning 8-second videos using Fal.ai Veo3 (Powered by Google Veo)
        </p>
      </div>

      {/* Video Prompt Input */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Video Description
          </CardTitle>
          <CardDescription>
            Describe the video you want to create in detail. Videos are exactly 8 seconds long.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            placeholder="Describe your video scene in detail..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="resize-none"
          />

          {/* Suggested Prompts */}
          <div>
            <Label className="text-sm font-medium">Quick suggestions:</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestedPrompts.map((suggestion, index) => (
                <Button
                  key={index}
                  variant="outline"
                  size="sm"
                  className="text-xs h-7"
                  onClick={() => setPrompt(suggestion)}
                >
                  {suggestion.length > 50 ? suggestion.substring(0, 50) + "..." : suggestion}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Generation Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Film className="h-4 w-4" />
            Video Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Fixed Duration Display */}
          <div>
            <Label className="flex items-center justify-between">
              <span>Duration: 8 seconds</span>
              <Badge variant="secondary">Fixed</Badge>
            </Label>
            <p className="text-sm text-muted-foreground mt-1">
              All videos are exactly 8 seconds long as per Fal.ai Veo3 specifications
            </p>
          </div>

          {/* Aspect Ratio */}
          <div>
            <Label className="flex items-center gap-2 mb-3">
              <Monitor className="h-4 w-4" />
              Aspect Ratio
            </Label>
            <Select value={aspectRatio} onValueChange={(value) => setAspectRatio(value as '16:9' | '9:16' | '1:1')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="16:9">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4" />
                    16:9 (Landscape)
                  </div>
                </SelectItem>
                <SelectItem value="9:16">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4" />
                    9:16 (Portrait)
                  </div>
                </SelectItem>
                <SelectItem value="1:1">
                  <div className="flex items-center gap-2">
                    <Square className="h-4 w-4" />
                    1:1 (Square)
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Negative Prompt */}
          <div>
            <Label>Negative Prompt (Optional)</Label>
            <Input
              placeholder="Things to avoid in the video (e.g., blurry, low quality, text)"
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Specify what you don't want to see in your video
            </p>
          </div>

          {/* Generate Button */}
          <Button
            onClick={generateVideo}
            disabled={isGenerating || !prompt.trim()}
            className="w-full"
            size="lg"
          >
            {isGenerating ? (
              <>
                <ThinkingIndicator size="sm" className="mr-2" />
                Generating Video...
              </>
            ) : (
              <>
                <Video className="h-4 w-4 mr-2" />
                Generate 8s Video
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Generation Status */}
      {currentOperation && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {getStatusIcon(currentOperation.status)}
              Video Generation Status
              <Badge variant={currentOperation.status === 'completed' ? 'default' : 'secondary'}>
                {currentOperation.status}
              </Badge>
            </CardTitle>
            <CardDescription>
              {currentOperation.prompt.length > 100
                ? `${currentOperation.prompt.substring(0, 100)}...`
                : currentOperation.prompt}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {currentOperation.status === 'processing' && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Generating video...</span>
                  <span className="text-sm text-muted-foreground">
                    Est. {currentOperation.estimatedTime}
                  </span>
                </div>
                <Progress value={undefined} className="w-full" />
                {currentOperation.queuePosition !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    Queue position: {currentOperation.queuePosition}
                  </p>
                )}
              </div>
            )}

            {currentOperation.status === 'failed' && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-800">
                  Generation failed: {currentOperation.error}
                </p>
              </div>
            )}

            {currentOperation.status === 'timeout' && (
              <div className="p-4 bg-orange-50 border border-orange-200 rounded-lg">
                <p className="text-sm text-orange-800">
                  Generation timed out. Please try again.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Generated Video Player */}
      {generatedVideo && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Video className="h-4 w-4" />
              Generated Video
              <Badge variant="default">Completed</Badge>
            </CardTitle>
            <CardDescription>
              {generatedVideo.prompt.length > 100
                ? `${generatedVideo.prompt.substring(0, 100)}...`
                : generatedVideo.prompt}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">


            {/* Video Player */}
            <div className="relative bg-black rounded-lg overflow-hidden flex items-center justify-center">
              <video
                ref={videoRef}
                src={`${apiClient.apiBaseURL}${generatedVideo.video_url}`}
                className="w-full h-auto max-h-[70vh] object-contain"
                poster=""
                preload="metadata"
                style={{
                  aspectRatio: generatedVideo.aspect_ratio === '16:9' ? '16/9' :
                    generatedVideo.aspect_ratio === '9:16' ? '9/16' : '1/1'
                }}
              />
              {/* Video Controls Overlay */}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
                <div className="flex items-center gap-4">
                  <Button
                    onClick={togglePlayPause}
                    variant="ghost"
                    size="sm"
                    className="text-white hover:bg-white/20"
                  >
                    {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </Button>

                  <div className="flex-1 flex items-center gap-2">
                    <span className="text-xs text-white">
                      {formatTime(currentTime)}
                    </span>
                    <div className="flex-1 bg-white/20 rounded-full h-1">
                      <div
                        className="bg-white dark:bg-zinc-300 h-1 rounded-full transition-all"
                        style={{
                          width: totalDuration ? `${(currentTime / totalDuration) * 100}%` : '0%'
                        }}
                      />
                    </div>
                    <span className="text-xs text-white">
                      {formatTime(totalDuration)}
                    </span>
                  </div>

                  <Button
                    onClick={toggleFullscreen}
                    variant="ghost"
                    size="sm"
                    className="text-white hover:bg-white/20"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-3">
              <Button onClick={downloadVideo} className="flex-1">
                <Download className="h-4 w-4 mr-2" />
                Download Video
              </Button>
              <Button
                onClick={() => {
                  setGeneratedVideo(null)
                  setCurrentOperation(null)
                }}
                variant="outline"
                className="flex-1"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Create New Video
              </Button>
            </div>

            {/* Volume Control */}
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4" />
              <div className="flex-1 flex items-center gap-2">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={volume[0]}
                  onChange={(e) => setVolume([parseFloat(e.target.value)])}
                  className="flex-1"
                />
                <span className="text-xs text-muted-foreground w-10">
                  {Math.round(volume[0] * 100)}%
                </span>
              </div>
            </div>

            {/* Video Info */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground">Duration</p>
                <p className="font-medium">8 seconds</p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground">Aspect Ratio</p>
                <p className="font-medium flex items-center gap-1">
                  {getAspectRatioIcon(generatedVideo.aspect_ratio)}
                  {generatedVideo.aspect_ratio}
                </p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground">Resolution</p>
                <p className="font-medium">
                  {generatedVideo.width && generatedVideo.height
                    ? `${generatedVideo.width}×${generatedVideo.height}`
                    : '720p HD'
                  }
                </p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground">File Size</p>
                <p className="font-medium">
                  {generatedVideo.file_size
                    ? `${(generatedVideo.file_size / 1024 / 1024).toFixed(1)} MB`
                    : 'N/A'
                  }
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
