"use client"

import React, { useState, useEffect } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import apiClient from '@/lib/api'
import { useVoices } from '@/hooks/use-voices'

interface Voice {
  voiceId: string
  name: string
  category: string
  description?: string
  previewUrl?: string
  labels?: { [key: string]: string }
}

interface VoiceSelectorProps {
  selectedVoice: string
  onVoiceChange: (voiceId: string) => void
  label?: string
  className?: string
}

export default function VoiceSelector({ 
  selectedVoice, 
  onVoiceChange, 
  label = "Voice",
  className = "" 
}: VoiceSelectorProps) {
  const { voices, loading: voicesLoading } = useVoices()

  const [isLoading, setIsLoading] = useState(true)


  return (
    <div className={`space-y-2 ${className}`}>
      <Label>{label}</Label>
      <Select 
        value={selectedVoice} 
        onValueChange={(value) => {
          console.log(`Voice selector - ${label} - Voice selected:`, value)
          // Save to localStorage for persistence
          if (typeof window !== 'undefined') {
            localStorage.setItem('selectedVoiceId', value)
            console.log('Saved voice to localStorage:', value)
          }
          onVoiceChange(value)
        }}
        disabled={voicesLoading}
      >
        <SelectTrigger>
          {selectedVoice ? (
            <span>
              {voices.find((v) => v.voiceId === selectedVoice)?.name || 'Unknown Voice'}
            </span>
          ) : (
            <SelectValue placeholder={voicesLoading ? "Loading voices..." : "Choose a voice"} />
          )}
        </SelectTrigger>
        <SelectContent>
          {voices.map((voice) => (
            <SelectItem key={voice.voiceId} value={voice.voiceId}>
              <div className="flex items-center gap-2">
                <span>{voice.name}</span>
                <Badge variant="secondary" className="text-xs">
                  {voice.category}
                </Badge>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}