"use client"

import { useState, useEffect, useRef } from 'react'
import { apiClient } from '@/lib/api'
import { devLog } from '@/lib/dev-log'

interface Voice {
  voiceId: string
  name: string
  category: string
  description?: string
  previewUrl?: string
  labels?: { [key: string]: string }
}

// Global state to prevent multiple API calls
let globalVoices: Voice[] = []
let isLoading = false
let hasLoaded = false

const listeners = new Set<(voices: Voice[]) => void>()

const loadVoicesOnce = async () => {
  if (hasLoaded || isLoading) {
    return globalVoices
  }

  isLoading = true
  try {
    devLog('Loading voices (one time only)...')
    const response = await apiClient.getVoices()
    globalVoices = response.voices || []
    hasLoaded = true
    
    // Notify all listeners
    listeners.forEach(listener => listener(globalVoices))
    
    devLog('Voices loaded successfully:', globalVoices.length)
    return globalVoices
  } catch (error) {
    console.error('Failed to load voices:', error)
    return []
  } finally {
    isLoading = false
  }
}

export const useVoices = () => {
  const [voices, setVoices] = useState<Voice[]>(globalVoices)
  const [loading, setLoading] = useState(!hasLoaded)

  useEffect(() => {
    const listener = (newVoices: Voice[]) => {
      setVoices(newVoices)
      setLoading(false)
    }

    listeners.add(listener)

    // Load voices if not already loaded
    if (!hasLoaded && !isLoading) {
      loadVoicesOnce().then(voices => {
        setVoices(voices)
        setLoading(false)
      })
    } else if (hasLoaded) {
      setVoices(globalVoices)
      setLoading(false)
    }

    return () => {
      listeners.delete(listener)
    }
  }, [])

  return { voices, loading }
}

// Reset function for testing or when needed
export const resetVoices = () => {
  globalVoices = []
  hasLoaded = false
  isLoading = false
}