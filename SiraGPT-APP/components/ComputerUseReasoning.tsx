"use client"

import React from 'react'
import { Bot } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface ReasoningStep {
  text: string
  timestamp: number
  action?: string
}

interface ComputerUseReasoningProps {
  step: ReasoningStep
  stepNumber: number
}

export const ComputerUseReasoning: React.FC<ComputerUseReasoningProps> = ({ 
  step, 
  stepNumber 
}) => {
  return (
    <div className="flex gap-3 p-3 bg-muted/50 rounded-lg">
      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">
        {stepNumber}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Agente Computer Use</span>
        </div>
        <p className="text-sm text-foreground">{step.text}</p>
        {step.action && (
          <Badge variant="outline" className="mt-2 text-xs">
            {step.action}
          </Badge>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {new Date(step.timestamp).toLocaleTimeString()}
        </p>
      </div>
    </div>
  )
}

export default ComputerUseReasoning