"use client"

// Performance optimization utilities for chat application

export class PerformanceOptimizer {
  private static instance: PerformanceOptimizer
  private renderTimes: Map<string, number[]> = new Map()
  private memoryUsage: number[] = []

  static getInstance(): PerformanceOptimizer {
    if (!PerformanceOptimizer.instance) {
      PerformanceOptimizer.instance = new PerformanceOptimizer()
    }
    return PerformanceOptimizer.instance
  }

  // Track component render times
  trackRender(componentName: string, renderTime: number) {
    if (!this.renderTimes.has(componentName)) {
      this.renderTimes.set(componentName, [])
    }
    const times = this.renderTimes.get(componentName)!
    times.push(renderTime)
    
    // Keep only last 10 render times
    if (times.length > 10) {
      times.shift()
    }
  }

  // Get average render time for component
  getAverageRenderTime(componentName: string): number {
    const times = this.renderTimes.get(componentName)
    if (!times || times.length === 0) return 0
    return times.reduce((a, b) => a + b, 0) / times.length
  }

  // Monitor memory usage
  trackMemoryUsage() {
    if ('memory' in performance) {
      const memInfo = (performance as any).memory
      this.memoryUsage.push(memInfo.usedJSHeapSize)
      
      // Keep only last 20 readings
      if (this.memoryUsage.length > 20) {
        this.memoryUsage.shift()
      }
    }
  }

  // Check if memory is getting high
  isMemoryHigh(): boolean {
    if (this.memoryUsage.length < 5) return false
    const recent = this.memoryUsage.slice(-5)
    const average = recent.reduce((a, b) => a + b, 0) / recent.length
    return average > 50 * 1024 * 1024 // 50MB threshold
  }

  // Optimize DOM for large content
  static optimizeDOM() {
    // Remove unused elements
    const unusedElements = document.querySelectorAll('[data-unused="true"]')
    unusedElements.forEach(el => el.remove())

    // Compress whitespace in text nodes
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    )

    const textNodes: Text[] = []
    let node: Node | null
    while (node = walker.nextNode()) {
      if (node.nodeValue && node.nodeValue.trim() === '') {
        textNodes.push(node as Text)
      }
    }

    textNodes.forEach(textNode => {
      if (textNode.parentNode && textNode.nodeValue) {
        textNode.nodeValue = textNode.nodeValue.replace(/\s+/g, ' ')
      }
    })
  }

  // Debounce expensive operations
  static debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number,
    immediate?: boolean
  ): T {
    let timeout: NodeJS.Timeout | null
    return ((...args: any[]) => {
      const later = () => {
        timeout = null
        if (!immediate) func(...args)
      }
      const callNow = immediate && !timeout
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(later, wait)
      if (callNow) func(...args)
    }) as T
  }

  // Throttle scroll and resize events
  static throttle<T extends (...args: any[]) => any>(
    func: T,
    limit: number
  ): T {
    let inThrottle: boolean
    return ((...args: any[]) => {
      if (!inThrottle) {
        func(...args)
        inThrottle = true
        setTimeout(() => inThrottle = false, limit)
      }
    }) as T
  }

  // Memory-efficient string operations for large responses
  static processLargeContent(content: string, chunkSize: number = 5000): string[] {
    if (content.length <= chunkSize) return [content]
    
    const chunks: string[] = []
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.slice(i, i + chunkSize))
    }
    return chunks
  }

  // Clean up unused resources
  static cleanup() {
    // Clear caches
    if ('caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => {
          if (name.includes('temp') || name.includes('old')) {
            caches.delete(name)
          }
        })
      })
    }

    // Force garbage collection if available
    if ('gc' in window && typeof (window as any).gc === 'function') {
      (window as any).gc()
    }
  }

  // Lightweight monitoring - reduced overhead
  static startPerformanceMonitoring() {
    // Throttled memory monitoring only
    let lastMemoryCheck = 0
    const checkInterval = 30000 // 30 seconds instead of 10
    
    const throttledMemoryCheck = () => {
      const now = Date.now()
      if (now - lastMemoryCheck > checkInterval) {
        lastMemoryCheck = now
        const optimizer = PerformanceOptimizer.getInstance()
        optimizer.trackMemoryUsage()
        if (optimizer.isMemoryHigh()) {
          // Only cleanup, don't log to reduce console spam
          PerformanceOptimizer.cleanup()
        }
      }
    }
    
    // Use requestIdleCallback if available, otherwise throttled interval
    if ('requestIdleCallback' in window) {
      const idleCallback = () => {
        throttledMemoryCheck()
        requestIdleCallback(idleCallback)
      }
      requestIdleCallback(idleCallback)
    } else {
      setInterval(throttledMemoryCheck, checkInterval)
    }
  }
}

// React performance utilities
export const ReactPerformanceUtils = {
  // Lazy load components
  lazyLoad: <T extends React.ComponentType<any>>(
    importFunc: () => Promise<{ default: T }>
  ) => {
    return React.lazy(importFunc)
  },

  // Memoize expensive calculations
  memoize: <T extends (...args: any[]) => any>(fn: T): T => {
    const cache = new Map()
    return ((...args: any[]) => {
      const key = JSON.stringify(args)
      if (cache.has(key)) {
        return cache.get(key)
      }
      const result = fn(...args)
      cache.set(key, result)
      return result
    }) as T
  },

  // Check if component should update
  shouldComponentUpdate: (prevProps: any, nextProps: any, keys: string[]) => {
    return keys.some(key => prevProps[key] !== nextProps[key])
  }
}

import React from 'react'

// Initialize performance monitoring on import
if (typeof window !== 'undefined') {
  PerformanceOptimizer.startPerformanceMonitoring()
}