"use client"

import { useState, useEffect } from "react"

/**
 * useDebounce — delays updating the value until after `delay` ms of inactivity.
 * Use for search inputs, resize handlers, scroll events.
 */
export function useDebounce<T>(value: T, delay: number = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/**
 * useDebouncedCallback — wraps a callback with debounce.
 * Use for API calls triggered by keystrokes.
 */
export function useDebouncedCallback<T extends (...args: any[]) => void>(
  callback: T,
  delay: number = 300
) {
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null)

  const debouncedFn = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    const newTimer = setTimeout(() => callback(...args), delay)
    setTimer(newTimer)
  }

  return debouncedFn
}
