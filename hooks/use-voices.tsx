"use client"

import { useState, useEffect, useCallback } from 'react'
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
let globalError: string | null = null
let isLoading = false
let hasLoaded = false

type VoiceListener = {
  onVoices: (voices: Voice[]) => void
  onError: (message: string) => void
}

const listeners = new Set<VoiceListener>()

function friendlyVoiceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  if (/401|403|unauthorized|forbidden|sesión|token/i.test(message)) {
    return 'Tu sesión expiró. Vuelve a iniciar sesión para ver el catálogo.'
  }
  if (/network|fetch|failed|timeout|abort/i.test(message)) {
    return 'Sin conexión con el servidor de voces. Revisa tu red e inténtalo de nuevo.'
  }
  return 'No se pudo cargar el catálogo de voces. Inténtalo de nuevo.'
}

const loadVoicesOnce = async () => {
  if (hasLoaded || isLoading) {
    return globalVoices
  }

  isLoading = true
  globalError = null
  try {
    devLog('Loading voices (one time only)...')
    const response = await apiClient.getVoices()
    globalVoices = response.voices || []
    hasLoaded = true

    // Notify all listeners
    listeners.forEach(listener => listener.onVoices(globalVoices))

    devLog('Voices loaded successfully:', globalVoices.length)
    return globalVoices
  } catch (error) {
    console.error('Failed to load voices:', error)
    globalError = friendlyVoiceError(error)
    listeners.forEach(listener => listener.onError(globalError as string))
    return []
  } finally {
    isLoading = false
  }
}

export const useVoices = () => {
  const [voices, setVoices] = useState<Voice[]>(globalVoices)
  const [loading, setLoading] = useState(!hasLoaded)
  const [error, setError] = useState<string | null>(globalError)

  const retry = useCallback(() => {
    // A load already in flight will notify listeners when it settles —
    // don't stomp it with a stale early-return.
    if (isLoading) return
    hasLoaded = false
    globalError = null
    setError(null)
    setLoading(true)
    void loadVoicesOnce().then(fetched => {
      setVoices(fetched)
      setError(globalError)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    const listener: VoiceListener = {
      onVoices: (newVoices) => {
        setVoices(newVoices)
        setError(null)
        setLoading(false)
      },
      onError: (message) => {
        setError(message)
        setLoading(false)
      },
    }

    listeners.add(listener)

    // Load voices if not already loaded
    if (!hasLoaded && !isLoading) {
      loadVoicesOnce().then(fetched => {
        setVoices(fetched)
        setError(globalError)
        setLoading(false)
      })
    } else if (hasLoaded) {
      setVoices(globalVoices)
      setError(null)
      setLoading(false)
    } else if (globalError) {
      setError(globalError)
      setLoading(false)
    }

    return () => {
      listeners.delete(listener)
    }
  }, [])

  return { voices, loading, error, retry }
}

// Reset function for testing or when needed
export const resetVoices = () => {
  globalVoices = []
  globalError = null
  hasLoaded = false
  isLoading = false
}