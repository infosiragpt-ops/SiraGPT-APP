"use client"

import React, { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { useToast } from '@/hooks/use-toast'
import apiClient from '@/lib/api'
import VoiceSelector from './voice-selector'
import { devLog } from '@/lib/dev-log'
import {
  Mic,
  Play,
  Pause,
  Square,
  Download,
  Upload,
  Volume2,
  Settings,
  FileAudio,
  MessageSquare
} from 'lucide-react'
import { useVoices } from '@/hooks/use-voices'

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
interface Voice {
  voiceId: string
  name: string
  category: string
  description?: string
  previewUrl?: string
  labels?: { [key: string]: string }
}

interface VoiceSettings {
  stability: number
  similarity_boost: number
  style: number
  use_speaker_boost: boolean
}

export default function ElevenLabsInterface() {
  const { toast } = useToast()
const { voices, loading: voicesLoading } = useVoices()

  // State management
  const [selectedVoice, setSelectedVoice] = useState<string>('')
  const [text, setText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [transcribedText, setTranscribedText] = useState('')
  const [recordingTime, setRecordingTime] = useState(0)
  const [sttLanguage, setSttLanguage] = useState<string>('auto')
  const [tagAudioEvents, setTagAudioEvents] = useState(true)
  const [diarize, setDiarize] = useState(false)

  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    stability: 0.5,
    similarity_boost: 0.5,
    style: 0.0,
    use_speaker_boost: true
  })

  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Load voices on component mount

  // Recording timer
  useEffect(() => {
    if (isRecording) {
      recordingIntervalRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1)
      }, 1000)
    } else {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current)
      }
      setRecordingTime(0)
    }

    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current)
      }
    }
  }, [isRecording])

  // Sync audio element when audioUrl changes
  useEffect(() => {
    if (audioUrl && audioRef.current) {
      // Ensure the audio element has the correct src
      const expectedSrc = `${apiClient.apiBaseURL}${audioUrl}`
      if (audioRef.current.src !== expectedSrc) {
        audioRef.current.src = expectedSrc
      }

      // Set up event listeners for synchronization
      const audio = audioRef.current

      const handleEnded = () => setIsPlaying(false)
      const handlePause = () => setIsPlaying(false)
      const handlePlay = () => setIsPlaying(true)
      const handleLoadStart = () => setIsPlaying(false)

      audio.addEventListener('ended', handleEnded)
      audio.addEventListener('pause', handlePause)
      audio.addEventListener('play', handlePlay)
      audio.addEventListener('loadstart', handleLoadStart)

      return () => {
        audio.removeEventListener('ended', handleEnded)
        audio.removeEventListener('pause', handlePause)
        audio.removeEventListener('play', handlePlay)
        audio.removeEventListener('loadstart', handleLoadStart)
      }
    }
  }, [audioUrl])

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        setIsPlaying(false)
      }
    }
  }, [])

  const handleTextToSpeech = async () => {
    devLog("Starting TTS with:", { text, selectedVoice, voiceSettings })
    if (!text.trim()) {
      toast({
        title: "Error",
        description: "Please enter some text to convert to speech.",
        variant: "destructive"
      })
      return
    }

    if (!selectedVoice) {
      toast({
        title: "Error",
        description: "Please select a voice first.",
        variant: "destructive"
      })
      return
    }

    devLog("Selected voice ID:", selectedVoice)
    devLog("Available voices:", voices.length)
    setIsLoading(true)
    try {
      devLog('Making TTS request with:', {
        text,
        voice_id: selectedVoice,
        voice_settings: voiceSettings
      })

      const response = await apiClient.textToSpeech({
        text,
        voice_id: selectedVoice,
        voice_settings: voiceSettings
      })

      devLog('TTS response:', response)

      if (response.audio_url) {
        setAudioUrl(response.audio_url)

        // Wait a bit for the audio element to be ready, then auto-play
        setTimeout(() => {
          if (audioRef.current) {
            // Set up event listeners for the existing audio element
            audioRef.current.onended = () => setIsPlaying(false)
            audioRef.current.onpause = () => setIsPlaying(false)
            audioRef.current.onplay = () => setIsPlaying(true)
            audioRef.current.onloadstart = () => setIsPlaying(false)

            // Auto-play the generated audio
            audioRef.current.play()
            setIsPlaying(true)
          }
        }, 100)

        toast({
          title: "Success",
          description: "Audio generated and playing!",
        })
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to generate audio",
        variant: "destructive"
      })
    } finally {
      setIsLoading(false)
    }
  }

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mediaRecorder = new MediaRecorder(stream)

      mediaRecorderRef.current = mediaRecorder
      audioChunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data)
      }

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' })
        await handleSpeechToText(audioBlob)

        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop())
      }

      mediaRecorder.start()
      setIsRecording(true)

      toast({
        title: "Recording started",
        description: "Speak now... (Using ElevenLabs STT)",
      })
    } catch (error) {
      toast({
        title: "Error",
        description: "Could not access microphone. Please check permissions.",
        variant: "destructive"
      })
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
    }
  }

  const handleSpeechToText = async (audioBlob: Blob) => {
    setIsLoading(true)
    try {
      const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' })

      // Create form data with additional options
      const formData = new FormData()
      formData.append('audio', audioFile)
      formData.append('model', 'scribe_v1')
      if (sttLanguage !== 'auto') {
        formData.append('language', sttLanguage)
      }
      formData.append('tagAudioEvents', tagAudioEvents.toString())
      formData.append('diarize', diarize.toString())

      // Use ElevenLabs speech-to-text with options
      const response = await apiClient.speechToText(audioFile, 'scribe_v1')

      if (response.text) {
        setTranscribedText(response.text)
        const isFallback = response.fallback || response.note

        toast({
          title: "Success",
          description: isFallback
            ? `Audio processed. ${response.note || 'ElevenLabs STT may require a subscription plan.'}`
            : `Audio transcribed successfully using ElevenLabs!`,
        })
      }
    } catch (error: any) {
      console.error('Speech-to-text error:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to transcribe audio with ElevenLabs",
        variant: "destructive"
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('audio/')) {
      toast({
        title: "Error",
        description: "Please select an audio file.",
        variant: "destructive"
      })
      return
    }

    await handleSpeechToText(file)
  }

  const playAudio = () => {
    if (audioUrl && audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause()
        setIsPlaying(false)
      } else {
        // Set up event listeners if not already set
        if (!audioRef.current.onended) {
          audioRef.current.onended = () => setIsPlaying(false)
          audioRef.current.onpause = () => setIsPlaying(false)
          audioRef.current.onplay = () => setIsPlaying(true)
        }

        audioRef.current.play()
        setIsPlaying(true)
      }
    }
  }

  const downloadAudio = async () => {
    if (audioUrl) {
      try {
        const filename = audioUrl.split('/').pop() || 'audio.mp3'
        const blob = await apiClient.getAudioFile(filename)
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to download audio",
          variant: "destructive"
        })
      }
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">
          ElevenLabs Voice Studio
        </h1>
        <p className="text-muted-foreground">
          Convert text to speech and speech to text with AI-powered voices
        </p>
      </div>

      <Tabs defaultValue="tts" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="tts" className="flex items-center gap-2">
            <Volume2 className="w-4 h-4" />
            Text to Speech
          </TabsTrigger>
          <TabsTrigger value="stt" className="flex items-center gap-2">
            <Mic className="w-4 h-4" />
            Speech to Text
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tts" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5" />
                Text to Speech
              </CardTitle>
              <CardDescription>
                Enter text and convert it to natural-sounding speech
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <VoiceSelector
                selectedVoice={selectedVoice}
                onVoiceChange={(value) => {
                  devLog("ElevenLabs interface - Voice selected:", value)
                  setSelectedVoice(value)
                }}
                label="Select Voice"
              />

              <div className="space-y-2">
                <Label htmlFor="text-input">Text to Convert</Label>
                <Textarea
                  id="text-input"
                  placeholder="Escribe el texto que quieres convertir a voz…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                  className="resize-none"
                />
                <div className="text-sm text-muted-foreground">
                  {text.length} characters
                </div>
              </div>

              <Card className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Settings className="w-4 h-4" />
                  <Label>Ajustes de voz</Label>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Estabilidad: {voiceSettings.stability}</Label>
                    <Slider
                      value={[voiceSettings.stability]}
                      onValueChange={([value]) =>
                        setVoiceSettings(prev => ({ ...prev, stability: value }))
                      }
                      max={1}
                      min={0}
                      step={0.1}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Similitud: {voiceSettings.similarity_boost}</Label>
                    <Slider
                      value={[voiceSettings.similarity_boost]}
                      onValueChange={([value]) =>
                        setVoiceSettings(prev => ({ ...prev, similarity_boost: value }))
                      }
                      max={1}
                      min={0}
                      step={0.1}
                    />
                  </div>
                </div>
              </Card>

              <Button
                onClick={handleTextToSpeech}
                disabled={isLoading || !text.trim()}
                className="w-full"
              >
                {isLoading ? (
                  <>
                    <ThinkingIndicator size="sm" className="mr-2" />
                    Generating Audio...
                  </>
                ) : (
                  <>
                    <Volume2 className="w-4 h-4 mr-2" />
                    Generate Speech
                  </>
                )}
              </Button>

              {isLoading && (
                <div className="text-center text-sm text-muted-foreground">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                    <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                  </div>
                  <p className="mt-1">Creating your audio with ElevenLabs...</p>
                </div>
              )}

              {audioUrl && (
                <Card className="p-4 bg-gradient-to-r from-green-50 to-blue-50 dark:from-green-950/20 dark:to-blue-950/20 border-green-200 dark:border-green-800">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileAudio className="w-5 h-5 text-green-600" />
                      <span className="font-medium text-green-800 dark:text-green-200">Audio generado</span>
                      {isPlaying && (
                        <div className="flex items-center gap-1 text-green-600">
                          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                          <span className="text-xs">Reproduciendo</span>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={playAudio}
                        className={`${isPlaying ? 'bg-green-100 border-green-300 text-green-700' : ''}`}
                      >
                        {isPlaying ? (
                          <Pause className="w-4 h-4" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </Button>
                      <Button variant="outline" size="sm" onClick={downloadAudio}>
                        <Download className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  <audio
                    ref={audioRef}
                    src={`${apiClient.apiBaseURL}${audioUrl}`}
                    className="w-full mt-2"
                    controls
                    preload="auto"
                  />
                  <div className="mt-2 text-xs text-muted-foreground">
                    Click the play button above or use the audio controls below - both are synchronized!
                  </div>
                </Card>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stt" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mic className="w-5 h-5" />
                Speech to Text
              </CardTitle>
              <CardDescription>
                Record audio or upload a file to convert speech to text
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Card className="p-4 bg-gradient-to-r from-purple-50 to-blue-50 border-purple-200">
                <div className="flex items-center gap-2 mb-2">
                  <Mic className="w-5 h-5 text-purple-600" />
                  <Label className="text-purple-800 font-medium">ElevenLabs Speech-to-Text</Label>
                </div>
                <p className="text-sm text-purple-700">
                  High-quality speech transcription with audio event detection and multilingual support using ElevenLabs Scribe model.
                </p>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="p-4">
                  <div className="text-center space-y-4">
                    <div className="flex justify-center">
                      {isRecording ? (
                        <div className="relative">
                          <div className="w-20 h-20 bg-red-500 rounded-full flex items-center justify-center animate-pulse">
                            <Mic className="w-8 h-8 text-white" />
                          </div>
                          <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2">
                            <Badge variant="destructive">
                              {formatTime(recordingTime)}
                            </Badge>
                          </div>
                        </div>
                      ) : (
                        <div className="w-20 h-20 bg-primary rounded-full flex items-center justify-center">
                          <Mic className="w-8 h-8 text-primary-foreground" />
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <h3 className="font-medium">Record Audio</h3>
                      <p className="text-sm text-muted-foreground">
                        Click to start recording your voice
                      </p>
                    </div>

                    <Button
                      onClick={isRecording ? stopRecording : startRecording}
                      disabled={isLoading}
                      variant={isRecording ? "destructive" : "default"}
                      className="w-full"
                    >
                      {isRecording ? (
                        <>
                          <Square className="w-4 h-4 mr-2" />
                          Stop Recording
                        </>
                      ) : (
                        <>
                          <Mic className="w-4 h-4 mr-2" />
                          Start Recording
                        </>
                      )}
                    </Button>
                  </div>
                </Card>

                <Card className="p-4">
                  <div className="text-center space-y-4">
                    <div className="flex justify-center">
                      <div className="w-20 h-20 bg-secondary rounded-full flex items-center justify-center">
                        <Upload className="w-8 h-8 text-secondary-foreground" />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h3 className="font-medium">Upload Audio</h3>
                      <p className="text-sm text-muted-foreground">
                        Upload an audio file to transcribe
                      </p>
                    </div>

                    <Button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isLoading}
                      variant="outline"
                      className="w-full"
                    >
                      <Upload className="w-4 h-4 mr-2" />
                      Choose File
                    </Button>

                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                  </div>
                </Card>
              </div>

              {isLoading && (
                <Card className="p-4">
                  <div className="flex items-center justify-center space-x-2">
                    <ThinkingIndicator size="md" />
                    <span>Transcribiendo audio…</span>
                  </div>
                  <Progress value={undefined} className="mt-2" />
                </Card>
              )}

              {transcribedText && (
                <Card className="p-4">
                  <div className="space-y-2">
                    <Label>Texto transcrito</Label>
                    <Textarea
                      value={transcribedText}
                      onChange={(e) => setTranscribedText(e.target.value)}
                      rows={4}
                      className="resize-none"
                    />
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">
                        {transcribedText.length} characters
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(transcribedText)
                          toast({
                            title: "Copied",
                            description: "Text copied to clipboard",
                          })
                        }}
                      >
                        Copy Text
                      </Button>
                    </div>
                  </div>
                </Card>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}