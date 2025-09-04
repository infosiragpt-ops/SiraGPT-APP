"use client"

import React, { useState, useEffect } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import apiClient from '@/lib/api'

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
  const [voices, setVoices] = useState<Voice[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    loadVoices()
  }, [])

  const loadVoices = async () => {
    try {
      setIsLoading(true)
      const response = await apiClient.getVoices()
      setVoices(response.voices || [])
      
      // Try to load saved voice from localStorage first
      const savedVoiceId = typeof window !== 'undefined' ? localStorage.getItem('selectedVoiceId') : null
      
      if (savedVoiceId && response.voices?.find(v => v.voiceId === savedVoiceId)) {
        // Use saved voice if it exists in the available voices
        if (!selectedVoice) {
          console.log('Loading saved voice from localStorage:', savedVoiceId)
          onVoiceChange(savedVoiceId)
        }
      } else if (!selectedVoice && response.voices && response.voices.length > 0) {
        // Auto-select first voice if none selected and no saved voice
        console.log('Auto-selecting first voice:', response.voices[0].voiceId)
        onVoiceChange(response.voices[0].voiceId)
      }
    } catch (error) {
      console.error('Failed to load voices:', error)
    } finally {
      setIsLoading(false)
    }
  }

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
        disabled={isLoading}
      >
        <SelectTrigger>
          {selectedVoice ? (
            <span>
              {voices.find((v) => v.voiceId === selectedVoice)?.name || 'Unknown Voice'}
            </span>
          ) : (
            <SelectValue placeholder={isLoading ? "Loading voices..." : "Choose a voice"} />
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