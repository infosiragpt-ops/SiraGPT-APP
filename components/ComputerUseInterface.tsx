"use client"

import React, { useState } from 'react'
import { 
  Monitor, 
  Eye,
  EyeOff
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface ComputerUseInterfaceProps {
  screenshot?: string | null
  status?: 'idle' | 'running' | 'completed' | 'error'
  onClose?: () => void
}

const ComputerUseInterface: React.FC<ComputerUseInterfaceProps> = ({ 
  screenshot,
  status = 'idle',
  onClose
}) => {
  const [isVisible, setIsVisible] = useState(true)

  return (
    <div className="w-full h-full flex flex-col">
      {/* Controls */}
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Monitor className="h-5 w-5" />
              Computer Use Preview
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsVisible(!isVisible)}
              >
                {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                {isVisible ? 'Hide' : 'Show'}
              </Button>
              <Badge variant={
                status === 'running' ? 'default' : 
                status === 'completed' ? 'secondary' : 
                status === 'error' ? 'destructive' : 'outline'
              }>
                {status}
              </Badge>
              {onClose && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onClose}
                >
                  ×
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      {isVisible && (
        <div className="flex-1 min-h-0">
          {/* Browser Preview */}
          <Card className="flex flex-col h-full">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Live Browser View</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 p-0">
              <div className="h-full bg-muted rounded-lg overflow-hidden">
                {screenshot ? (
                  <img
                    src={screenshot}
                    alt="Computer Use Screenshot"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <Monitor className="h-12 w-12 mx-auto mb-2" />
                      <p>Browser view will appear here</p>
                      <p className="text-sm mt-1">Computer Use session will display live screenshots</p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

export default ComputerUseInterface