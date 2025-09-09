"use client"

import React, { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/hooks/use-toast'
import apiClient from '@/lib/api'
import VoiceSelector from './voice-selector'
import {
  Mic,
  Play,
  Pause,
  Settings,
  Loader2,
  Square
} from 'lucide-react'
import { useVoices } from '@/hooks/use-voices'

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

interface VoiceControlsProps {
  onTranscription?: (text: string) => void
  className?: string
}

export default function VoiceControls({ onTranscription, className = "" }: VoiceControlsProps) {
  const { toast } = useToast()

// In the component, replace the voices state and loadVoices logic:
const { voices, loading: voicesLoading } = useVoices()

  const [selectedVoice, setSelectedVoice] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [recordedAudio, setRecordedAudio] = useState<HTMLAudioElement | null>(null)
  const [voiceSettings, setVoiceSettings] = useState<VoiceSettings>({
    stability: 0.5,
    similarity_boost: 0.5,
    style: 0.0,
    use_speaker_boost: true
  })

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null)

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
useEffect(() => {
  if (voices.length > 0 && !selectedVoice) {
    setSelectedVoice(voices[0].voiceId)
    console.log('Voice controls selected voice:', voices[0].voiceId)
  }
}, [voices, selectedVoice])

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
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })

        // Create audio element for playback
        const audioUrl = URL.createObjectURL(audioBlob)
        const audio = new Audio(audioUrl)
        setRecordedAudio(audio)

        // Set up audio event listeners
        audio.onplay = () => setIsPlaying(true)
        audio.onpause = () => setIsPlaying(false)
        audio.onended = () => setIsPlaying(false)

        await handleSpeechToText(audioBlob)

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
      console.log('Using ElevenLabs API for speech-to-text')
      console.log('Audio blob details:', {
        size: audioBlob.size,
        type: audioBlob.type
      })
      
      // Create audio file for ElevenLabs API
      const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' })
      console.log('Audio file details:', {
        name: audioFile.name,
        size: audioFile.size,
        type: audioFile.type
      })
      
      const response = await apiClient.speechToText(audioFile)

      if (response.text && onTranscription) {
        onTranscription(response.text)
        toast({
          title: "Success",
          description: "Audio transcribed successfully with ElevenLabs!",
        })
      }
    } catch (error: any) {
      console.error('ElevenLabs speech-to-text error:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to transcribe audio",
        variant: "destructive"
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleTextToSpeech = async (text: string) => {
    if (!text.trim() || !selectedVoice) {
      console.log("TTS validation failed:", { text: text.trim(), selectedVoice })
      return
    }

    setIsLoading(true)
    try {
      console.log("Voice controls TTS request:", { text, voice_id: selectedVoice, voice_settings: voiceSettings })
      const response = await apiClient.textToSpeech({
        text,
        voice_id: selectedVoice,
        voice_settings: voiceSettings
      })

      if (response.audio_url) {
        const audio = new Audio(`${apiClient.apiBaseURL}${response.audio_url}`)
        audioRef.current = audio

        audio.onplay = () => setIsPlaying(true)
        audio.onpause = () => setIsPlaying(false)
        audio.onended = () => setIsPlaying(false)

        audio.play()
      }
    } catch (error: any) {
      console.error("Voice controls TTS error:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to generate audio",
        variant: "destructive"
      })
    } finally {
      setIsLoading(false)
    }
  }

  const togglePlayback = () => {
    // Priority: recorded audio first, then TTS audio
    const currentAudio = recordedAudio || audioRef.current
    if (currentAudio) {
      if (isPlaying) {
        currentAudio.pause()
      } else {
        currentAudio.play()
      }
    }
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {/* Recording Button */}
      <Button
        variant={isRecording ? "destructive" : "outline"}
        size="sm"
        onClick={isRecording ? stopRecording : startRecording}
        disabled={isLoading}
        className="relative"
      >
        {isRecording ? (
          <>
            <Square className="w-4 h-4" />
            {recordingTime > 0 && (
              <Badge
                variant="destructive"
                className="absolute -top-2 -right-2 text-xs px-1"
              >
                {formatTime(recordingTime)}
              </Badge>
            )}
          </>
        ) : (
          <Mic className="w-4 h-4" />
        )}
      </Button>

      {/* Voice Settings Popover */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <Settings className="w-4 h-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-4">
            <VoiceSelector
              selectedVoice={selectedVoice}
              onVoiceChange={setSelectedVoice}
              label="Voice for TTS"
            />

            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Stability: {voiceSettings.stability.toFixed(1)}</Label>
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
                <Label>Similarity: {voiceSettings.similarity_boost.toFixed(1)}</Label>
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
          </div>
        </PopoverContent>
      </Popover>

      {/* Playback Control - show when we have recorded audio or TTS audio */}
      {(recordedAudio || audioRef.current) && (
        <Button
          variant="outline"
          size="sm"
          onClick={togglePlayback}
          disabled={isLoading}
          title={isPlaying ? "Pause audio" : "Play audio"}
        >
          {isPlaying ? (
            <Pause className="w-4 h-4" />
          ) : (
            <Play className="w-4 h-4" />
          )}
        </Button>
      )}

      {/* Loading Indicator */}
      {isLoading && (
        <div className="flex items-center">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      )}
    </div>
  )
}

// Create a voice context for sharing voice selection across components
const VoiceContext = React.createContext<{
  selectedVoice: string
  setSelectedVoice: (voiceId: string) => void
  voices: Voice[]
}>({
  selectedVoice: '',
  setSelectedVoice: () => {},
  voices: []
})

// Voice provider component
export const VoiceProvider = ({ children }: { children: React.ReactNode }) => {
  const [selectedVoice, setSelectedVoice] = React.useState<string>('')
  const [voices, setVoices] = React.useState<Voice[]>([])


  return (
    <VoiceContext.Provider value={{ selectedVoice, setSelectedVoice, voices }}>
      {children}
    </VoiceContext.Provider>
  )
}

// Hook to use voice context
export const useVoiceContext = () => {
  const context = React.useContext(VoiceContext)
  if (!context) {
    throw new Error('useVoiceContext must be used within VoiceProvider')
  }
  return context
}

// Export a function to be used by message components
export const useVoiceControls = () => {
  const [defaultVoiceId, setDefaultVoiceId] = React.useState<string>('')
  const [voices, setVoices] = React.useState<Voice[]>([])


  const handleTextToSpeech = React.useCallback(async (text: string, voiceId?: string) => {
    try {
      if (!text.trim()) {
        throw new Error("No text provided for TTS")
      }

      // Try to get voice from localStorage first (user preference)
      const savedVoiceId = typeof window !== 'undefined' ? localStorage.getItem('selectedVoiceId') : null
      const selectedVoiceId = voiceId || savedVoiceId || defaultVoiceId
      
      if (!selectedVoiceId) {
        throw new Error("No voice selected for TTS")
      }

      console.log("useVoiceControls TTS request:", { 
        text: text.substring(0, 50) + '...', 
        voice_id: selectedVoiceId,
        voiceName: voices.find(v => v.voiceId === selectedVoiceId)?.name || 'Unknown',
        providedVoiceId: voiceId,
        savedVoiceId: savedVoiceId,
        defaultVoiceId: defaultVoiceId
      })
      
      const response = await apiClient.textToSpeech({
        text,
        voice_id: selectedVoiceId
      })

      if (response.audio_url) {
        const audio = new Audio(`${apiClient.apiBaseURL}${response.audio_url}`)
        audio.play()
        return audio
      }
    } catch (error) {
      console.error('Text-to-speech error:', error)
      throw error
    }
  }, [defaultVoiceId, voices])

  return { handleTextToSpeech, voices, defaultVoiceId }
}