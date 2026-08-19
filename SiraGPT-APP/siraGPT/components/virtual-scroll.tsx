"use client"

import React, { useState, useEffect, useRef, useMemo } from 'react'

interface VirtualScrollProps {
  items: any[]
  itemHeight: number
  containerHeight: number
  overscan?: number
  renderItem: (item: any, index: number) => React.ReactNode
  className?: string
}

export const VirtualScroll: React.FC<VirtualScrollProps> = ({
  items,
  itemHeight,
  containerHeight,
  overscan = 3,
  renderItem,
  className = ''
}) => {
  const [scrollTop, setScrollTop] = useState(0)
  const scrollElementRef = useRef<HTMLDivElement>(null)

  // Calculate visible range
  const visibleRange = useMemo(() => {
    const startIndex = Math.floor(scrollTop / itemHeight)
    const endIndex = Math.min(
      startIndex + Math.ceil(containerHeight / itemHeight) + overscan,
      items.length
    )
    return {
      start: Math.max(0, startIndex - overscan),
      end: endIndex
    }
  }, [scrollTop, itemHeight, containerHeight, overscan, items.length])

  // Get visible items
  const visibleItems = useMemo(() => {
    return items.slice(visibleRange.start, visibleRange.end).map((item, index) => ({
      item,
      index: visibleRange.start + index
    }))
  }, [items, visibleRange])

  // Handle scroll
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }

  // Auto-scroll to bottom for new messages
  useEffect(() => {
    if (scrollElementRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollElementRef.current
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 100
      
      if (isAtBottom) {
        scrollElementRef.current.scrollTop = scrollHeight
      }
    }
  }, [items.length])

  const totalHeight = items.length * itemHeight
  const offsetY = visibleRange.start * itemHeight

  return (
    <div
      ref={scrollElementRef}
      className={`overflow-auto ${className}`}
      style={{ height: containerHeight }}
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleItems.map(({ item, index }) => (
            <div
              key={index}
              style={{ height: itemHeight }}
              className="flex items-start"
            >
              {renderItem(item, index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default VirtualScroll