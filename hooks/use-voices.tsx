"use client"

import { useState, useEffect } from 'react'
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
// null until the first answer: whether the server has an ElevenLabs key.
let globalConfigured: boolean | null = null
let isLoading = false
let hasLoaded = false
// A failed load (network/5xx) is retried at most once per cooldown, never on
// every consumer mount.
let lastFailureAt = 0
const RETRY_AFTER_FAILURE_MS = 60_000

const listeners = new Set<(voices: Voice[]) => void>()

const loadVoicesOnce = async () => {
  if (hasLoaded || isLoading) {
    return globalVoices
  }
  if (lastFailureAt && Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    return globalVoices
  }

  isLoading = true
  try {
    devLog('Loading voices (one time only)...')
    const response = await apiClient.getVoices()
    globalVoices = response?.voices || []
    // `configured: false` = no ElevenLabs key on the server: an empty catalog
    // is the final answer, not a failure to retry.
    globalConfigured = response?.configured !== false
    hasLoaded = true
    lastFailureAt = 0

    // Notify all listeners
    listeners.forEach(listener => listener(globalVoices))

    devLog('Voices loaded successfully:', globalVoices.length)
    return globalVoices
  } catch (error) {
    lastFailureAt = Date.now()
    console.error('Failed to load voices:', error)
    // Stop every waiting consumer's spinner; the next mount after the
    // cooldown retries.
    listeners.forEach(listener => listener(globalVoices))
    return []
  } finally {
    isLoading = false
  }
}

/**
 * Shared ElevenLabs voice catalog. `enabled: false` defers the request until
 * the consumer actually shows the catalog (e.g. a picker that is mounted but
 * closed), so /agentes page loads never ask for voices nobody opened.
 */
export const useVoices = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const [voices, setVoices] = useState<Voice[]>(globalVoices)
  const [loading, setLoading] = useState(!hasLoaded && enabled)
  const [configured, setConfigured] = useState<boolean | null>(globalConfigured)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }

    const listener = (newVoices: Voice[]) => {
      setVoices(newVoices)
      setConfigured(globalConfigured)
      setLoading(false)
    }

    listeners.add(listener)

    // Load voices if not already loaded
    if (!hasLoaded && !isLoading) {
      setLoading(true)
      loadVoicesOnce().then(voices => {
        setVoices(voices)
        setConfigured(globalConfigured)
        setLoading(false)
      })
    } else if (hasLoaded) {
      setVoices(globalVoices)
      setConfigured(globalConfigured)
      setLoading(false)
    }

    return () => {
      listeners.delete(listener)
    }
  }, [enabled])

  return { voices, loading, configured }
}

// Reset function for testing or when needed
export const resetVoices = () => {
  globalVoices = []
  globalConfigured = null
  hasLoaded = false
  isLoading = false
  lastFailureAt = 0
}
