"use client"

import { useState, useCallback } from "react"

/**
 * useAsyncWithRetry — wraps an async operation with automatic retry
 * and error handling. Shows toast on final failure.
 * 
 * Usage:
 *   const { execute, loading, error, retryCount } = useAsyncWithRetry(fetchData, {
 *     retries: 3,
 *     retryDelay: 1000,
 *     onSuccess: (data) => setData(data),
 *     onError: (err) => console.error(err),
 *   })
 */

interface UseAsyncRetryOptions<T> {
  retries?: number
  retryDelay?: number
  onSuccess?: (data: T) => void
  onError?: (error: Error) => void
  shouldRetry?: (error: Error) => boolean
}

interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: Error | null
  retryCount: number
}

export function useAsyncWithRetry<T, Args extends any[] = any[]>(
  asyncFn: (...args: Args) => Promise<T>,
  options: UseAsyncRetryOptions<T> = {}
) {
  const {
    retries = 3,
    retryDelay = 1000,
    onSuccess,
    onError,
    shouldRetry = () => true,
  } = options

  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: false,
    error: null,
    retryCount: 0,
  })

  const execute = useCallback(
    async (...args: Args) => {
      setState((s) => ({ ...s, loading: true, error: null, retryCount: 0 }))

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const result = await asyncFn(...args)
          setState({ data: result, loading: false, error: null, retryCount: attempt })
          onSuccess?.(result)
          return result
        } catch (err: any) {
          const isLastAttempt = attempt === retries
          const error = err instanceof Error ? err : new Error(String(err))

          if (isLastAttempt || !shouldRetry(error)) {
            setState((s) => ({ ...s, loading: false, error, retryCount: attempt }))
            onError?.(error)
            throw error
          }

          // Exponential backoff: delay * 2^attempt
          await new Promise((res) => setTimeout(res, retryDelay * Math.pow(2, attempt)))
          setState((s) => ({ ...s, retryCount: attempt + 1 }))
        }
      }

      throw new Error("Unreachable")
    },
    [asyncFn, retries, retryDelay, onSuccess, onError, shouldRetry]
  )

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: null, retryCount: 0 })
  }, [])

  return {
    ...state,
    execute,
    reset,
  }
}

/**
 * useApiRetry — specialized for API calls with network retry logic.
 * Retries on network errors, not on 4xx client errors.
 */
export function useApiRetry<T, Args extends any[] = any[]>(
  apiFn: (...args: Args) => Promise<T>,
  options?: Omit<UseAsyncRetryOptions<T>, "shouldRetry">
) {
  return useAsyncWithRetry(apiFn, {
    retries: 3,
    retryDelay: 800,
    shouldRetry: (error) => {
      // Only retry on network errors, timeouts, or 5xx
      const msg = error.message.toLowerCase()
      return (
        msg.includes("fetch") ||
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("econnrefused") ||
        msg.includes("unexpected token") // JSON parse fail from partial response
      )
    },
    ...options,
  })
}
