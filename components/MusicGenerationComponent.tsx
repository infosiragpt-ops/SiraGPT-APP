"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Slider } from "@/components/ui/slider"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Music, Play, Pause, Download, Volume2, Clock, Sparkles } from "lucide-react"
import { apiClient } from "@/lib/api"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"
import { toast } from "sonner"
import { useAuth } from "@/lib/auth-context-integrated"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface MusicStyle {
  id: string;
  name: string;
  description: string;
}

interface GeneratedMusic {
  audio_url: string;
  filename: string;
  duration: number;
  text_prompt: string;
}

type MusicGenerationComponentProps = {
  initialDuration?: number
  initialPromptInfluence?: number
  initialStyle?: string
  initialMood?: string
  initialEffect?: string
}

export default function MusicGenerationComponent({
  initialDuration = 10,
  initialPromptInfluence = 0.3,
  initialStyle = "",
  initialMood = "",
  initialEffect = "",
}: MusicGenerationComponentProps = {}) {
  const { user } = useAuth()
  const isPrivilegedUser = user?.isSuperAdmin === true || (user as any)?.role === "SUPER_ADMIN"
  const isFreePlan = String(user?.plan || "FREE").trim().toUpperCase() === "FREE" && !isPrivilegedUser
  const [prompt, setPrompt] = React.useState("")
  const [duration, setDuration] = React.useState([initialDuration])
  const [promptInfluence, setPromptInfluence] = React.useState([initialPromptInfluence])
  const [selectedStyle, setSelectedStyle] = React.useState<string>(initialStyle === "Auto" ? "" : initialStyle)
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [generatedMusic, setGeneratedMusic] = React.useState<GeneratedMusic | null>(null)
  const [musicStyles, setMusicStyles] = React.useState<MusicStyle[]>([])
  const [isPlaying, setIsPlaying] = React.useState(false)
  const [currentTime, setCurrentTime] = React.useState(0)
  const [totalDuration, setTotalDuration] = React.useState(0)
  const [volume, setVolume] = React.useState([0.8])

  const audioRef = React.useRef<HTMLAudioElement>(null)

  React.useEffect(() => {
    fetchMusicStyles()
  }, [])

  React.useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const updateTime = () => setCurrentTime(audio.currentTime)
    const updateDuration = () => setTotalDuration(audio.duration)
    const handleEnded = () => setIsPlaying(false)

    audio.addEventListener('timeupdate', updateTime)
    audio.addEventListener('loadedmetadata', updateDuration)
    audio.addEventListener('ended', handleEnded)

    return () => {
      audio.removeEventListener('timeupdate', updateTime)
      audio.removeEventListener('loadedmetadata', updateDuration)
      audio.removeEventListener('ended', handleEnded)
    }
  }, [generatedMusic])

  React.useEffect(() => {
    const audio = audioRef.current
    if (audio) {
      audio.volume = volume[0]
    }
  }, [volume])

  const fetchMusicStyles = async () => {
    try {
      const response = await apiClient.getMusicStyles()
      setMusicStyles(response.styles || [])
    } catch (error) {
      console.error('Error fetching music styles:', error)
      toast.error('Failed to load music styles')
    }
  }

  const generateMusic = async () => {
    const normalized = normalizeChatInput(prompt)
    if (shouldWarnUser(normalized)) {
      toast.error(
        `La descripción supera el límite (${normalized.originalLength.toLocaleString()} caracteres). Se recortó.`,
        { duration: 4500 },
      )
    }
    const cleanPrompt = normalized.value.trim()
    if (!cleanPrompt) {
      toast.error('Please enter a music description')
      return
    }
    if (isFreePlan) {
      toast.info('Música está en vista previa para usuarios FREE. Sube de plan para generar audio.')
      return
    }

    setIsGenerating(true)
    try {
      const fullPrompt = selectedStyle
        ? `${selectedStyle} style${initialMood ? `, ${initialMood} mood` : ""}${initialEffect ? `, ${initialEffect} effect` : ""}: ${cleanPrompt}`
        : `${initialMood || initialEffect ? `${[initialMood, initialEffect].filter(Boolean).join(", ")}: ` : ""}${cleanPrompt}`

      const response = await apiClient.generateMusic({
        text: fullPrompt,
        duration: duration[0],
        prompt_influence: promptInfluence[0],
      })

      if (response.success) {
        setGeneratedMusic(response)
        toast.success('Music generated successfully!')
      } else {
        toast.error(response.error || 'Failed to generate music')
      }
    } catch (error: any) {
      console.error('Music generation error:', error)
      
      if (error.message?.includes('402') || error.message?.includes('credits')) {
        toast.error('Insufficient credits for music generation. Please upgrade your ElevenLabs subscription.')
      } else if (error.message?.includes('400')) {
        toast.error('Invalid music generation parameters. Please check your input.')
      } else {
        toast.error('Failed to generate music. Please try again.')
      }
    } finally {
      setIsGenerating(false)
    }
  }

  const togglePlayPause = () => {
    const audio = audioRef.current
    if (!audio) return

    if (isPlaying) {
      audio.pause()
    } else {
      audio.play()
    }
    setIsPlaying(!isPlaying)
  }

  // const downloadMusic = () => {
  //   if (!generatedMusic) return

  //   const link = document.createElement('a')
  //   link.href = `${apiClient.apiBaseURL}${generatedMusic.audio_url}`
  //   link.download = generatedMusic.filename
  //   document.body.appendChild(link)
  //   link.click()
  //   document.body.removeChild(link)
  //   toast.success('Music download started')
  // }
const downloadMusic = async () => {
  if (!generatedMusic) return

  try {
    const res = await fetch(`${apiClient.apiBaseURL}${generatedMusic.audio_url}`, {
      credentials: 'include', // add if API requires cookies/auth
    })
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)

    const link = document.createElement('a')
    link.href = url
    link.download = generatedMusic.filename || 'music.mp3'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    // cleanup
    URL.revokeObjectURL(url)

    toast.success('Music download started')
  } catch (err) {
    console.error('Download failed:', err)
    toast.error('Failed to download music')
  }
}


  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.floor(seconds % 60)
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
  }

  const suggestedPrompts = [
    "Peaceful ambient music for meditation",
    "Upbeat electronic dance track",
    "Emotional piano piece in minor key",
    "Epic cinematic orchestral theme",
    "Smooth jazz with saxophone melody",
    "Nature sounds with gentle acoustic guitar",
    "Dark atmospheric horror soundtrack",
    "Happy pop song with bright melodies"
  ]

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="text-lg font-semibold flex items-center justify-center gap-2">
          <Music className="h-5 w-5" />
          AI Music Generation
          {isFreePlan && <Badge variant="secondary">Vista previa</Badge>}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          Create original music using AI-powered generation
        </p>
      </div>

      {/* Music Prompt Input */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Music Description
          </CardTitle>
          <CardDescription>
            Describe the music you want to generate. Be specific about style, mood, and instruments.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="music-prompt">Descripción de la música</Label>
            <Textarea
              id="music-prompt"
              placeholder="Describe en detalle la música que quieres generar…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[100px] mt-2"
              disabled={isGenerating}
            />
          </div>

          {/* Suggested Prompts */}
          <div>
            <Label className="text-sm font-medium">Ideas sugeridas</Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {suggestedPrompts.map((suggestion, index) => (
                <Badge
                  key={index}
                  variant="outline"
                  className="cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors"
                  onClick={() => setPrompt(suggestion)}
                >
                  {suggestion}
                </Badge>
              ))}
            </div>
          </div>

          {/* Music Style Selector */}
          {musicStyles.length > 0 && (
            <div>
              <Label htmlFor="music-style">Estilo musical (opcional)</Label>
              <Select value={selectedStyle} onValueChange={setSelectedStyle}>
                <SelectTrigger className="mt-2">
                  <SelectValue placeholder="Elige un estilo musical" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Sin estilo específico</SelectItem>
                  {musicStyles.map((style) => (
                    <SelectItem key={style.id} value={style.name}>
                      <div>
                        <div className="font-medium">{style.name}</div>
                        <div className="text-xs text-muted-foreground">{style.description}</div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Generation Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Generation Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <Label className="flex items-center justify-between">
              Duration: {duration[0]} seconds
              <span className="text-xs text-muted-foreground">
                ({formatTime(duration[0])})
              </span>
            </Label>
            <Slider
              value={duration}
              onValueChange={setDuration}
              max={30}
              min={5}
              step={1}
              className="mt-2"
              disabled={isGenerating}
            />
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>5s</span>
              <span>30s</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Generate Button */}
      <Button
        onClick={generateMusic}
        disabled={!prompt.trim() || isGenerating || isFreePlan}
        className="w-full"
        size="lg"
      >
        {isGenerating ? (
          <>
            <ThinkingIndicator size="sm" className="mr-2" />
            Generating Music...
          </>
        ) : (
          <>
            <Music className="mr-2 h-4 w-4" />
            {isFreePlan ? 'Sube de plan para generar' : 'Generate Music'}
          </>
        )}
      </Button>

      {/* Generated Music Player */}
      {generatedMusic && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Music className="h-4 w-4" />
              Generated Music
            </CardTitle>
            <CardDescription>
              "{generatedMusic.text_prompt}"
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <audio
              ref={audioRef}
              src={`${apiClient.apiBaseURL}${generatedMusic.audio_url}`}
              preload="metadata"
            />

            {/* Player Controls */}
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="sm"
                onClick={togglePlayPause}
                className="flex items-center gap-2"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {isPlaying ? 'Pause' : 'Play'}
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={downloadMusic}
                className="flex items-center gap-2"
              >
                <Download className="h-4 w-4" />
                Download
              </Button>
            </div>

            {/* Progress Bar */}
            <div className="space-y-2">
              <Progress 
                value={totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0} 
                className="h-2"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(totalDuration)}</span>
              </div>
            </div>

            {/* Volume Control */}
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4" />
              <Slider
                value={volume}
                onValueChange={setVolume}
                max={1}
                min={0}
                step={0.1}
                className="flex-1"
              />
              <span className="text-xs text-muted-foreground w-10">
                {Math.round(volume[0] * 100)}%
              </span>
            </div>

            {/* Music Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Duración:</span>
                <div className="font-medium">{generatedMusic.duration}s</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
