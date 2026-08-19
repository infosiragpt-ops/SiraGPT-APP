"use client"

import React, { useState } from 'react'
import { BookOpen, Plus, X, Search, FileText, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useChat } from '@/lib/chat-context-integrated'
import { useAuth } from '@/lib/auth-context-integrated'
import { toast } from 'sonner'

interface ThesisChatConnectorProps {
  onComplete?: () => void
}

const ThesisChatConnector: React.FC<ThesisChatConnectorProps> = ({ onComplete }) => {
  const [topics, setTopics] = useState<string[]>(['', ''])
  const { addThesisMessage, currentChat, setChatType } = useChat()
  const { user } = useAuth()
  const isPrivilegedUser = user?.isSuperAdmin === true || (user as any)?.role === "SUPER_ADMIN"
  const isFreePlan = String(user?.plan || "FREE").trim().toUpperCase() === "FREE" && !isPrivilegedUser

  const addTopic = () => {
    setTopics([...topics, ''])
  }

  const removeTopic = (index: number) => {
    if (topics.length > 2) {
      setTopics(topics.filter((_, i) => i !== index))
    }
  }

  const updateTopic = (index: number, value: string) => {
    const newTopics = [...topics]
    newTopics[index] = value
    setTopics(newTopics)
  }

  const handleGenerate = async () => {
    const validTopics = topics.filter(t => t.trim().length > 0)
    
    if (validTopics.length === 0) {
      toast.error('Please add at least one topic')
      return
    }
    if (isFreePlan) {
      toast.info('Tesis está en vista previa para usuarios FREE. Sube de plan para generar documentos.')
      return
    }

    try {
      setChatType('thesis')
      await addThesisMessage(validTopics)
      
      // Reset topics after successful generation
      setTopics(['', ''])
      
      if (onComplete) {
        onComplete()
      }
    } catch (error: any) {
      console.error('Error generating thesis:', error)
      toast.error(error.message || 'Failed to start thesis generation')
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <BookOpen className="h-5 w-5" />
          Thesis Generator
          {isFreePlan && <Badge variant="secondary">Vista previa</Badge>}
        </CardTitle>
        <CardDescription className="text-sm">
          Generate comprehensive academic theses from research topics. The AI will search different websites, collect materials, and create a detailed thesis document. You can provide one topic for a focused thesis or multiple topics for comparative analysis.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Topics Input */}
        <div className="space-y-3">
          <label className="text-sm font-medium">Temas de investigación</label>
          {topics.map((topic, index) => (
            <div key={index} className="flex gap-2">
              <Input
                placeholder={`Tema ${index + 1} (p. ej., "Inteligencia artificial en la salud")`}
                value={topic}
                onChange={(e) => updateTopic(index, e.target.value)}
                className="flex-1 text-sm"
                />
              {topics.length > 2 && (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => removeTopic(index)}
                  className="h-9 w-9"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
          
          {topics.length < 5 && (
            <Button
              variant="outline"
              onClick={addTopic}
              className="w-full h-8 text-sm"
              size="sm"
            >
              <Plus className="h-3 w-3 mr-2" />
              Añadir otro tema
            </Button>
          )}
        </div>

        {/* Generate Button */}
        <Button
          onClick={handleGenerate}
          disabled={topics.filter(t => t.trim().length > 0).length < 1 || !currentChat || isFreePlan}
          className="w-full"
          size="sm"
        >
          <Search className="h-4 w-4 mr-2" />
          {isFreePlan ? 'Sube de plan para generar' : 'Generar tesis en el chat'}
        </Button>

        {/* Quick Examples */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Ejemplos rápidos:</label>
          <div className="grid grid-cols-1 gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-auto p-2 text-left justify-start text-xs"
              onClick={() => setTopics(['Artificial Intelligence in Healthcare'])}
            >
              Single Topic: AI in Healthcare
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-auto p-2 text-left justify-start text-xs"
              onClick={() => setTopics(['Artificial Intelligence in Healthcare', 'Machine Learning Ethics'])}
            >
              Multiple Topics: AI in Healthcare + ML Ethics
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-auto p-2 text-left justify-start text-xs"
              onClick={() => setTopics(['Climate Change Mitigation', 'Renewable Energy Technologies', 'Environmental Policy'])}
            >
              Comparative: Climate + Energy + Policy
            </Button>
          </div>
        </div>

        {/* Info Alert */}
        <Alert className="border-blue-200 bg-blue-50">
          <FileText className="h-4 w-4" />
          <AlertDescription className="text-xs">
            <strong>Process:</strong> Searches academic sources → Collects research materials → Generates comprehensive thesis → Provides downloadable Word document
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  )
}

export default ThesisChatConnector
