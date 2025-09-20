"use client"

import * as React from "react"
import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  Bot,
  Save,
  Eye,
  Upload,
  X,
  Plus,
  Trash2,
  Wand2,
  Settings,
  MessageSquare,
  Globe,
  Database,
  ImageIcon,
  Code,
  Loader2,
  Sparkles,
  BookOpen,
  Briefcase,
  Palette,
  Search,
  Users,
  Heart,
  Gamepad2,
  TrendingUp,
  Star,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Slider } from "@/components/ui/slider"
import { useAuth } from "@/lib/auth-context-integrated"
import { useChat } from "@/lib/chat-context-integrated"
import { toast } from "sonner"
import { gptsService, type CustomGPT } from "@/lib/gpts-service"

// Categories - matching the GPTs page
const categories = [
  { name: "Writing", icon: <BookOpen className="w-4 h-4" /> },
  { name: "Productivity", icon: <Briefcase className="w-4 h-4" /> },
  { name: "Programming", icon: <Code className="w-4 h-4" /> },
  { name: "Design", icon: <Palette className="w-4 h-4" /> },
  { name: "Research & Analysis", icon: <Search className="w-4 h-4" /> },
  { name: "Education", icon: <BookOpen className="w-4 h-4" /> },
  { name: "Data Analysis", icon: <Users className="w-4 h-4" /> },
  { name: "Lifestyle", icon: <Heart className="w-4 h-4" /> },
  { name: "Entertainment", icon: <Gamepad2 className="w-4 h-4" /> },
  { name: "Marketing", icon: <TrendingUp className="w-4 h-4" /> },
  { name: "Finance", icon: <Users className="w-4 h-4" /> },
  { name: "Health & Fitness", icon: <Heart className="w-4 h-4" /> },
  { name: "Travel", icon: <Globe className="w-4 h-4" /> },
  { name: "Other", icon: <Star className="w-4 h-4" /> },
]

interface GPTFormData {
  name: string
  description: string
  iconFile: File | null
  iconUrl: string | null
  instructions: string
  greetingMessage: string
  modelName: string
  temperature: number
  maxTokens: number | null
  conversationStarters: string[]
  visibility: "PRIVATE" | "UNLISTED" | "PUBLIC"
  category: string
  actions: any[]
  capabilities: {
    webBrowsing: boolean
    dataAnalysis: boolean
    imageGeneration: boolean
    codeInterpreter: boolean
  }
}

export default function CreateGPTPage() {
  const { user } = useAuth()
  const { availableModels } = useChat()
  const router = useRouter()
  const searchParams = useSearchParams()
  const editId = searchParams.get('edit')
  
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [uploadedImage, setUploadedImage] = useState<string | null>(null)
  const [isEditMode, setIsEditMode] = useState(false)

  const [formData, setFormData] = useState<GPTFormData>({
    name: "",
    description: "",
    iconFile: null,
    iconUrl: null,
    instructions: "",
    greetingMessage: "",
    modelName: "",
    temperature: 0.7,
    maxTokens: null,
    conversationStarters: ["", ""],
    visibility: "PRIVATE",
    category: "",
    actions: [],
    capabilities: {
      webBrowsing: false,
      dataAnalysis: false,
      imageGeneration: false,
      codeInterpreter: false,
    }
  })

  // Set default model when available models are loaded
  useEffect(() => {
    if (availableModels.length > 0 && !formData.modelName) {
      // Prefer GPT-4o mini as default, fallback to first available
      const defaultModel = availableModels.find(m => m.name === 'gpt-4o-mini') || availableModels[0]
      setFormData(prev => ({ ...prev, modelName: defaultModel.name }))
    }
  }, [availableModels, formData.modelName])

  // Load GPT data for editing
  useEffect(() => {
    if (editId) {
      setIsEditMode(true)
      loadGPTForEdit(editId)
    }
  }, [editId])

  const loadGPTForEdit = async (gptId: string) => {
    setIsLoading(true)
    try {
      const gpt = await gptsService.getGPT(gptId)
      
      // Convert GPT data to form data
      setFormData({
        name: gpt.name,
        description: gpt.description || "",
        iconFile: null,
        iconUrl: gpt.iconUrl || null,
        instructions: gpt.instructions,
        greetingMessage: gpt.greetingMessage || "",
        modelName: gpt.modelName,
        temperature: gpt.temperature,
        maxTokens: gpt.maxTokens,
        conversationStarters: gpt.conversationStarters?.length > 0 
          ? [...gpt.conversationStarters, ...Array(2).fill("")].slice(0, 4)
          : ["", ""],
        visibility: gpt.visibility,
        category: gpt.category || "",
        actions: gpt.actions || [],
        capabilities: {
          webBrowsing: false,
          dataAnalysis: false,
          imageGeneration: false,
          codeInterpreter: false,
        }
      })

      // If existing GPT has an icon URL, show it as preview
      if (gpt.iconUrl && (gpt.iconUrl.startsWith('http') || gpt.iconUrl.startsWith('https') || gpt.iconUrl.startsWith('data:'))) {
        setUploadedImage(gpt.iconUrl)
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to load GPT')
      router.push('/gpts')
    } finally {
      setIsLoading(false)
    }
  }

  const handleInputChange = (field: keyof GPTFormData, value: any) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }))
  }

  const handleConversationStarterChange = (index: number, value: string) => {
    const newStarters = [...formData.conversationStarters]
    newStarters[index] = value
    setFormData(prev => ({
      ...prev,
      conversationStarters: newStarters
    }))
  }

  const addConversationStarter = () => {
    if (formData.conversationStarters.length < 4) {
      setFormData(prev => ({
        ...prev,
        conversationStarters: [...prev.conversationStarters, ""]
      }))
    }
  }

  const removeConversationStarter = (index: number) => {
    if (formData.conversationStarters.length > 1) {
      const newStarters = formData.conversationStarters.filter((_, i) => i !== index)
      setFormData(prev => ({
        ...prev,
        conversationStarters: newStarters
      }))
    }
  }

  const handleCapabilityChange = (capability: keyof GPTFormData['capabilities'], enabled: boolean) => {
    setFormData(prev => ({
      ...prev,
      capabilities: {
        ...prev.capabilities,
        [capability]: enabled
      }
    }))
  }

  const validateForm = () => {
    if (!formData.name.trim()) {
      toast.error("Name is required")
      return false
    }
    if (!formData.description.trim()) {
      toast.error("Description is required")
      return false
    }
    if (!formData.instructions.trim()) {
      toast.error("Instructions are required")
      return false
    }
    if (!formData.modelName) {
      toast.error("Please select a model")
      return false
    }
    return true
  }

  const handleSave = async () => {
    if (!validateForm()) return

    setIsSaving(true)
    try {
      const gptData = {
        name: formData.name.trim(),
        description: formData.description.trim(),
        instructions: formData.instructions.trim(),
        greetingMessage: formData.greetingMessage.trim() || undefined,
        modelName: formData.modelName,
        temperature: formData.temperature,
        maxTokens: formData.maxTokens,
        conversationStarters: formData.conversationStarters.filter(s => s.trim()),
        visibility: formData.visibility,
        category: formData.category || undefined,
        capabilities: formData.capabilities,
        iconUrl: formData.iconUrl || undefined
      }

      // Handle icon upload if file is selected
      if (formData.iconFile) {
        // Create a text-based icon URL for now (since you mentioned emoji support)
        toast.info("Custom image upload is not yet implemented. Using text icon instead.")
      }

      let result: CustomGPT
      
      if (isEditMode && editId) {
        result = await gptsService.updateGPT(editId, gptData)
        toast.success("GPT updated successfully!")
      } else {
        result = await gptsService.createGPT(gptData)
        toast.success("GPT created successfully!")
      }
      
      router.push("/gpts")
    } catch (error: any) {
      toast.error(error.message || "Failed to save GPT")
    } finally {
      setIsSaving(false)
    }
  }

  const generateInstructions = () => {
    if (!formData.name || !formData.description) {
      toast.error("Please fill in name and description first")
      return
    }

 const suggestions = [
  `You are ${formData.name}. ${formData.description}. Always be helpful, accurate, and engaging in your responses. Provide detailed explanations and practical advice when needed.`,
  `As ${formData.name}, your primary goal is to help users with ${formData.description.toLowerCase()}. Provide detailed, actionable advice and be thorough in your explanations.`,
  `You are an expert ${formData.name}. Your specialization is ${formData.description.toLowerCase()}. Be thorough, precise, and helpful in all your interactions. Always ask clarifying questions when needed.`
]

    const randomSuggestion = suggestions[Math.floor(Math.random() * suggestions.length)]
    setFormData(prev => ({ ...prev, instructions: randomSuggestion }))
  }

  const generateGreeting = () => {
    if (!formData.name || !formData.description) {
      toast.error("Please fill in name and description first")
      return
    }

   const greetings = [
  `Hello! I'm ${formData.name}. I'm here to help you with ${formData.description.toLowerCase()}. What can I assist you with today?`,
  `Hi there! I'm ${formData.name}, your assistant for ${formData.description.toLowerCase()}. How can I help you get started?`,
  `Welcome! I'm ${formData.name} and I specialize in ${formData.description.toLowerCase()}. Feel free to ask me anything!`
]
    
    const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)]
    setFormData(prev => ({ ...prev, greetingMessage: randomGreeting }))
  }

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      if (file.size > 5 * 1024 * 1024) { // 5MB limit
        toast.error("Image size should be less than 5MB")
        return
      }
      
      setFormData(prev => ({ ...prev, iconFile: file }))
      
      const reader = new FileReader()
      reader.onload = (e) => {
        const result = e.target?.result as string
        setUploadedImage(result)
      }
      reader.readAsDataURL(file)
    }
  }

  const removeImage = () => {
    setUploadedImage(null)
    setFormData(prev => ({ ...prev, iconFile: null, iconUrl: null }))
  }

  const handleEmojiIcon = (emoji: string) => {
    setFormData(prev => ({ ...prev, iconUrl: emoji }))
    setUploadedImage(null) // Clear uploaded image if emoji is selected
  }

  const getNameInitial = () => {
    return formData.name ? formData.name.charAt(0).toUpperCase() : "?"
  }

  const hasCustomIcon = () => {
    return uploadedImage !== null || formData.iconUrl !== null
  }

  // Popular emoji options
  const emojiOptions = ["🤖", "💡", "📝", "🎨", "💻", "📊", "🚀", "⚡", "🎯", "🔧", "📚", "🌟"]

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading GPT...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="sm" onClick={() => router.back()}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
              <div className="flex items-center gap-2">
                <Bot className="h-6 w-6 text-primary" />
                <h1 className="text-2xl font-bold">
                  {isEditMode ? 'Edit GPT' : 'Create GPT'}
                </h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                onClick={() => setIsPreviewOpen(true)}
                disabled={!formData.name}
              >
                <Eye className="h-4 w-4 mr-2" />
                Preview
              </Button>
              <Button 
                onClick={handleSave}
                disabled={isSaving || !formData.name}
              >
                {isSaving ? "Saving..." : isEditMode ? "Update GPT" : "Create GPT"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container mx-auto px-4 py-6">
        <div className="max-w-4xl mx-auto space-y-8">
          
          {/* Basic Information Section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5" />
                Basic Information
              </CardTitle>
              <CardDescription>
                Define the basic properties of your GPT
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Avatar Selection */}
              <div className="space-y-4">
                <Label>Avatar</Label>
                
                {/* Avatar Preview */}
                <div className="flex items-start gap-6">
                  <div className="relative w-20 h-20 rounded-xl flex items-center justify-center text-3xl font-bold shadow-lg overflow-hidden">
                    {uploadedImage ? (
                      <>
                        <img 
                          src={uploadedImage} 
                          alt="Avatar" 
                          className="w-full h-full object-cover"
                        />
                        <button
                          onClick={removeImage}
                          className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-xs hover:bg-red-600"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </>
                    ) : formData.iconUrl ? (
                      <div className="w-full h-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white">
                        {formData.iconUrl}
                      </div>
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white">
                        {getNameInitial()}
                      </div>
                    )}
                  </div>
                  
                  <div className="flex-1 space-y-3">
                    {/* Emoji Options */}
                    <div>
                      <Label className="text-sm">Quick Icons</Label>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {emojiOptions.map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => handleEmojiIcon(emoji)}
                            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center text-lg hover:border-primary transition-colors ${
                              formData.iconUrl === emoji ? 'border-primary bg-primary/10' : 'border-border'
                            }`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    {/* Upload Image Button */}
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" asChild>
                        <label htmlFor="icon-upload" className="cursor-pointer">
                          <Upload className="h-4 w-4 mr-2" />
                          Upload Image
                        </label>
                      </Button>
                      <input
                        id="icon-upload"
                        type="file"
                        accept="image/*"
                        onChange={handleImageUpload}
                        className="hidden"
                      />
                      {hasCustomIcon() && (
                        <Button variant="outline" size="sm" onClick={removeImage}>
                          Remove
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Choose an emoji, upload an image, or use the first letter of your GPT's name
                    </p>
                  </div>
                </div>
              </div>

              {/* Name */}
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  placeholder="e.g., Code Reviewer, Creative Writer, Data Analyst"
                  value={formData.name}
                  onChange={(e) => handleInputChange("name", e.target.value)}
                  maxLength={100}
                />
                <div className="text-xs text-muted-foreground">
                  {formData.name.length}/100 characters
                </div>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description">Description *</Label>
                <Textarea
                  id="description"
                  placeholder="Describe what your GPT does and how it helps users. Be specific about its capabilities and use cases."
                  value={formData.description}
                  onChange={(e) => handleInputChange("description", e.target.value)}
                  maxLength={500}
                  rows={3}
                />
                <div className="text-xs text-muted-foreground">
                  {formData.description.length}/500 characters
                </div>
              </div>

              {/* Category */}
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Select value={formData.category} onValueChange={(value) => handleInputChange("category", value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((category) => (
                      <SelectItem key={category.name} value={category.name}>
                        <div className="flex items-center gap-2">
                          {category.icon}
                          {category.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Conversation Starters */}
              <div className="space-y-2">
                <Label>Conversation Starters</Label>
                <p className="text-sm text-muted-foreground">
                  Provide example prompts to help users get started with your GPT
                </p>
                <div className="space-y-2">
                  {formData.conversationStarters.map((starter, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        placeholder={`Example: "Help me write a professional email" or "Analyze this data set"`}
                        value={starter}
                        onChange={(e) => handleConversationStarterChange(index, e.target.value)}
                        maxLength={200}
                      />
                      {formData.conversationStarters.length > 2 && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => removeConversationStarter(index)}
                          className="shrink-0"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                  {formData.conversationStarters.length < 4 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={addConversationStarter}
                      className="w-full"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Conversation Starter
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Behavior Configuration Section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                Behavior Configuration
              </CardTitle>
              <CardDescription>
                Define how your GPT should behave and respond to users
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Instructions */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="instructions">Instructions *</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateInstructions}
                    disabled={!formData.name || !formData.description}
                  >
                    <Wand2 className="h-4 w-4 mr-2" />
                    Generate
                  </Button>
                </div>
                <Textarea
                  id="instructions"
                  placeholder="Provide detailed instructions for how your GPT should behave, respond, and interact with users. Include its personality, expertise level, response style, and any specific guidelines."
                  value={formData.instructions}
                  onChange={(e) => handleInputChange("instructions", e.target.value)}
                  rows={8}
                  maxLength={8000}
                />
                <div className="text-xs text-muted-foreground">
                  {formData.instructions.length}/8000 characters
                </div>
              </div>

              {/* Greeting Message */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="greeting">Greeting Message</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateGreeting}
                    disabled={!formData.name || !formData.description}
                  >
                    <Wand2 className="h-4 w-4 mr-2" />
                    Generate
                  </Button>
                </div>
                <Textarea
                  id="greeting"
                  placeholder="The first message your GPT will send to users when they start a conversation"
                  value={formData.greetingMessage}
                  onChange={(e) => handleInputChange("greetingMessage", e.target.value)}
                  rows={4}
                  maxLength={1000}
                />
                <div className="text-xs text-muted-foreground">
                  {formData.greetingMessage.length}/1000 characters
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Model Settings Section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Model & Visibility Settings
              </CardTitle>
              <CardDescription>
                Configure the AI model and who can access your GPT
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Model Selection */}
              <div className="space-y-2">
                <Label>AI Model *</Label>
                <Select value={formData.modelName} onValueChange={(value) => handleInputChange("modelName", value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((model) => (
                      <SelectItem key={model.name} value={model.name}>
                        <div className="flex flex-col">
                          <span className="font-medium">{model.displayName || model.name}</span>
                          {model.description && (
                            <span className="text-xs text-muted-foreground">{model.description}</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {availableModels.length === 0 && (
                  <p className="text-xs text-muted-foreground">Loading available models...</p>
                )}
              </div>

              {/* Temperature - Commented out for now */}
              {/* <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Creativity Level (Temperature)</Label>
                  <span className="text-sm text-muted-foreground">{formData.temperature}</span>
                </div>
                <Slider
                  value={[formData.temperature]}
                  onValueChange={(value) => handleInputChange("temperature", value[0])}
                  max={2}
                  min={0}
                  step={0.1}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>More Focused</span>
                  <span>More Creative</span>
                </div>
              </div> */}

              {/* Visibility */}
              <div className="space-y-2">
                <Label>Visibility</Label>
                <Select value={formData.visibility} onValueChange={(value: "PRIVATE" | "UNLISTED" | "PUBLIC") => handleInputChange("visibility", value)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRIVATE">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                        <div>
                          <div className="font-medium">Private</div>
                          <div className="text-xs text-muted-foreground">Only you can access</div>
                        </div>
                      </div>
                    </SelectItem>
                    <SelectItem value="UNLISTED">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
                        <div>
                          <div className="font-medium">Unlisted</div>
                          <div className="text-xs text-muted-foreground">Accessible via link only</div>
                        </div>
                      </div>
                    </SelectItem>
                    <SelectItem value="PUBLIC">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                        <div>
                          <div className="font-medium">Public</div>
                          <div className="text-xs text-muted-foreground">Anyone can discover and use</div>
                        </div>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

        </div>
      </div>

      {/* Preview Dialog */}
      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>GPT Preview</DialogTitle>
            <DialogDescription>
              Preview how your GPT will appear to users in the store
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* GPT Card Preview */}
            <div className="bg-white dark:bg-card rounded-lg p-6 border border-border">
              <div className="flex items-start space-x-4">
                <div className="w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold overflow-hidden">
                  {uploadedImage ? (
                    <img 
                      src={uploadedImage} 
                      alt="Avatar" 
                      className="w-full h-full object-cover rounded-full"
                    />
                  ) : formData.iconUrl ? (
                    <div className="w-full h-full bg-gradient-to-br from-purple-500 to-indigo-600 rounded-full flex items-center justify-center text-white">
                      {formData.iconUrl}
                    </div>
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-purple-500 to-indigo-600 rounded-full flex items-center justify-center text-white">
                      {getNameInitial()}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground mb-1 truncate">
                    {formData.name || "Untitled GPT"}
                  </h3>
                  <p className="text-muted-foreground text-sm mb-2 line-clamp-2">
                    {formData.description || "No description"}
                  </p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4 text-xs text-muted-foreground">
                      <span>By {user?.name || 'You'}</span>
                      <div className="flex items-center space-x-1">
                        <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                        <span>New</span>
                      </div>
                    </div>
                    <Button size="sm" className="px-3 py-1 text-xs">
                      Chat
                    </Button>
                  </div>
                </div>
              </div>
              
              {formData.category && (
                <Badge variant="outline" className="mt-3">
                  {formData.category}
                </Badge>
              )}
            </div>
            
            {/* Greeting Preview */}
            {formData.greetingMessage && (
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-sm">
                      {formData.iconUrl || getNameInitial()}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm">{formData.greetingMessage}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
            
            {/* Conversation Starters Preview */}
            {formData.conversationStarters.filter(s => s.trim()).length > 0 && (
              <div>
                <h4 className="font-medium mb-2 text-sm">Conversation Starters</h4>
                <div className="space-y-2">
                  {formData.conversationStarters.filter(s => s.trim()).map((starter, index) => (
                    <Button 
                      key={index} 
                      variant="outline" 
                      className="w-full justify-start text-left h-auto py-2 px-3 text-sm"
                    >
                      {starter}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}