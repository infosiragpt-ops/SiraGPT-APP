"use client"

import { useCallback, useMemo, useRef, useEffect } from 'react'
import { devLog } from '@/lib/dev-log'

// Debounce hook for performance optimization
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(handler)
    }
  }, [value, delay])

  return debouncedValue
}

// Throttle hook for scroll and resize events
export function useThrottle<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): T {
  const lastRun = useRef(Date.now())

  return useCallback(
    ((...args) => {
      if (Date.now() - lastRun.current >= delay) {
        callback(...args)
        lastRun.current = Date.now()
      }
    }) as T,
    [callback, delay]
  )
}

// Intersection Observer hook for lazy loading
export function useIntersectionObserver(
  elementRef: React.RefObject<Element>,
  options?: IntersectionObserverInit
) {
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(entry.isIntersecting)
    }, {
      threshold: 0.1,
      rootMargin: '50px',
      ...options
    })

    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [options])

  return isVisible
}

// Memory management hook - limits the number of items kept in memory
export function useMemoryOptimizedList<T>(
  items: T[],
  maxItems: number = 100,
  keepRecent: boolean = true
) {
  return useMemo(() => {
    if (items.length <= maxItems) return items
    
    if (keepRecent) {
      // Keep the most recent items
      return items.slice(-maxItems)
    } else {
      // Keep the first items
      return items.slice(0, maxItems)
    }
  }, [items, maxItems, keepRecent])
}

// Performance monitoring hook
export function usePerformanceMonitor(componentName: string) {
  const renderCount = useRef(0)
  const renderTime = useRef(performance.now())

  useEffect(() => {
    renderCount.current++
    const currentTime = performance.now()
    const timeSinceLastRender = currentTime - renderTime.current
    renderTime.current = currentTime

    if (renderCount.current % 10 === 0) {
      devLog(`${componentName}: ${renderCount.current} renders, last render took ${timeSinceLastRender.toFixed(2)}ms`)
    }
  })
}

// Optimize large content rendering
export function useChunkedContent(content: string, chunkSize: number = 1000) {
  return useMemo(() => {
    if (content.length <= chunkSize) return [content]
    
    const chunks = []
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize))
    }
    return chunks
  }, [content, chunkSize])
}

import { useState } from 'react'