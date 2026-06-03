"use client"

import * as React from "react"
import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  Bot,
  Eye,
  Upload,
  X,
  Wand2,
  Settings,
  MessageSquare,
  Globe,
  ImageIcon,
  Code,
  BookOpen,
  Briefcase,
  Palette,
  Search,
  Users,
  Heart,
  Gamepad2,
  TrendingUp,
  Star} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useAuth } from "@/lib/auth-context-integrated"
import { useChat } from "@/lib/chat-context-integrated"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { gptsService, type CustomGPT } from "@/lib/gpts-service"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
// Categories - matching the GPTs page
const categories = [
  { name: "Writing", icon: <BookOpen className="w-4 h-4" /> },
  { name: "Productivity", icon: <Briefcase className="w-4 h-4" /> },
  { name: "Programming", icon: <Code className="w-4 h-4" /> },
  { name: "Design", icon: <Palette className="w-4 h-4" /> },
  { name: "DALL·E", icon: <ImageIcon className="w-4 h-4" /> },
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

const liquidPanel =
  "relative overflow-hidden rounded-[24px] border border-white/60 bg-white/75 shadow-[0_18px_50px_-28px_rgba(15,23,42,0.35),inset_0_1px_0_rgba(255,255,255,0.78)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/55 dark:shadow-[0_18px_60px_-30px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.08)]"

const liquidField =
  "rounded-2xl border-white/65 bg-white/78 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl placeholder:text-zinc-400 focus-visible:ring-2 focus-visible:ring-zinc-950/10 dark:border-white/10 dark:bg-white/[0.055] dark:placeholder:text-zinc-500 dark:focus-visible:ring-white/15"

const liquidGhost =
  "rounded-full border-white/70 bg-white/70 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl hover:bg-white/90 hover:text-zinc-950 dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.1] dark:hover:text-white"

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
  const categoryParam = searchParams.get('category')

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
    // loadGPTForEdit is defined below in the component body, so adding
    // it to deps would lint-loop. Intent: re-fetch only when the
    // URL-bound editId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId])

  useEffect(() => {
    if (!editId && categoryParam && !formData.category) {
      setFormData(prev => ({ ...prev, category: categoryParam }))
    }
  }, [categoryParam, editId, formData.category])

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
        maxTokens: gpt.maxTokens || null,
        conversationStarters: gpt.conversationStarters && gpt.conversationStarters.length > 0
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
      // Normalize every free-text field before persistence. The
      // instructions field in particular tends to be a long paste and
      // benefits from the same zero-width / NUL / U+2028-9 strip the
      // chat composer uses; toast on truncation so the user knows the
      // saved GPT may have less detail than they pasted.
      const normalizedInstr = normalizeChatInput(formData.instructions)
      if (shouldWarnUser(normalizedInstr)) {
        toast.error(
          `Las instrucciones superan el límite (${normalizedInstr.originalLength.toLocaleString()} caracteres). Se recortaron.`,
          { duration: 4500 },
        )
      }
      const gptData = {
        name: normalizeChatInput(formData.name).value.trim(),
        description: normalizeChatInput(formData.description).value.trim(),
        instructions: normalizedInstr.value.trim(),
        greetingMessage: normalizeChatInput(formData.greetingMessage).value.trim() || undefined,
        modelName: formData.modelName,
        temperature: formData.temperature,
        maxTokens: formData.maxTokens || undefined,
        conversationStarters: formData.conversationStarters
          .map(s => normalizeChatInput(s).value.trim())
          .filter(s => s),
        visibility: formData.visibility,
        category: formData.category || undefined,
        capabilities: formData.capabilities,
        iconUrl: formData.iconUrl || undefined,
        iconFile: formData.iconFile || undefined,
      }

      let result: CustomGPT

      if (isEditMode && editId) {
        result = await gptsService.updateGPT(editId, gptData)
        toast.success("GPT actualizado")
      } else {
        result = await gptsService.createGPT(gptData)
        toast.success("GPT creado")
      }

      router.push("/gpts")
    } catch (error: any) {
      toast.error(error.message || "No se pudo guardar el GPT")
    } finally {
      setIsSaving(false)
    }
  }
  interface Template {
    tone: string;
    text: string;
  }
  interface Context {
    tone: "technical" | "creative" | "professional" | "conversational" | "general";
    domain: string;
  }
  // const generateInstructions = () => {
  //   if (!formData.name || !formData.description) {
  //     toast.error("Please fill in name and description first")
  //     return
  //   }

  //   const suggestions = [
  //     `You are ${formData.name}. ${formData.description}. Always be helpful, accurate, and engaging in your responses. Provide detailed explanations and practical advice when needed.`,
  //     `As ${formData.name}, your primary goal is to help users with ${formData.description.toLowerCase()}. Provide detailed, actionable advice and be thorough in your explanations.`,
  //     `You are an expert ${formData.name}. Your specialization is ${formData.description.toLowerCase()}. Be thorough, precise, and helpful in all your interactions. Always ask clarifying questions when needed.`
  //   ]

  //   const randomSuggestion = suggestions[Math.floor(Math.random() * suggestions.length)]
  //   setFormData(prev => ({ ...prev, instructions: randomSuggestion }))
  // }

  // const generateGreeting = () => {
  //   if (!formData.name || !formData.description) {
  //     toast.error("Please fill in name and description first")
  //     return
  //   }

  //   const greetings = [
  //     `Hello! I'm ${formData.name}. I'm here to help you with ${formData.description.toLowerCase()}. What can I assist you with today?`,
  //     `Hi there! I'm ${formData.name}, your assistant for ${formData.description.toLowerCase()}. How can I help you get started?`,
  //     `Welcome! I'm ${formData.name} and I specialize in ${formData.description.toLowerCase()}. Feel free to ask me anything!`
  //   ]

  //   const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)]
  //   setFormData(prev => ({ ...prev, greetingMessage: randomGreeting }))
  // }

  // Helper function to infer tone and context from description
  const inferContext = (description: string): Context => {
    const lowerDesc = description.toLowerCase();
    if (lowerDesc.includes("technical") || lowerDesc.includes("programming") || lowerDesc.includes("coding")) {
      return { tone: "technical", domain: "technical" };
    } else if (lowerDesc.includes("creative") || lowerDesc.includes("writing") || lowerDesc.includes("design")) {
      return { tone: "creative", domain: "creative" };
    } else if (lowerDesc.includes("business") || lowerDesc.includes("marketing") || lowerDesc.includes("strategy")) {
      return { tone: "professional", domain: "business" };
    }
    return { tone: "conversational", domain: "general" };
  };

  // Track used prompts to avoid repetition
  let usedInstructions: string[] = [];
  let usedGreetings: string[] = [];

  const generateInstructions = (): void => {
    if (!formData.name || !formData.description) {
      toast.error("Completa nombre y descripción primero");
      return;
    }

    const { tone } = inferContext(formData.description);

    // Reset usedInstructions if all templates are used
    if (usedInstructions.length >= 5) {
      usedInstructions = [];
    }

    const instructionTemplates: Template[] = [
      {
        tone: "technical",
        text: `You are ${formData.name}, a highly skilled expert in ${formData.description.toLowerCase()}. Provide precise, accurate, and detailed technical guidance. Include code examples, step-by-step explanations, and best practices when relevant. Always clarify ambiguous queries with follow-up questions to ensure accuracy. Maintain a professional and approachable tone, and structure your responses for clarity and depth.`,
      },
      {
        tone: "creative",
        text: `You are ${formData.name}, a creative specialist in ${formData.description.toLowerCase()}. Offer imaginative, detailed, and inspiring advice tailored to the user's needs. Provide examples, spark ideas, and encourage creative exploration. Use a warm, engaging tone and ask clarifying questions to better understand the user's goals. Ensure responses are vivid, structured, and actionable.`,
      },
      {
        tone: "professional",
        text: `You are ${formData.name}, an expert in ${formData.description.toLowerCase()}. Deliver professional, concise, and actionable advice tailored to business contexts. Focus on strategic insights, practical solutions, and clear communication. Use a formal yet approachable tone, and proactively ask questions to refine your understanding of the user's objectives. Structure your responses for clarity and impact.`,
      },
      {
        tone: "conversational",
        text: `You are ${formData.name}, dedicated to assisting with ${formData.description.toLowerCase()}. Engage users with a friendly, approachable tone, providing clear, detailed, and practical advice. Break down complex topics into simple, actionable steps, and ask clarifying questions to ensure relevance. Organize your responses logically and anticipate follow-up needs to enhance user experience.`,
      },
      {
        tone: "general",
        text: `You are ${formData.name}, an expert assistant specializing in ${formData.description.toLowerCase()}. Your goal is to provide comprehensive, accurate, and engaging responses. Adapt your tone to the user's needs, offering detailed explanations, practical tips, and relevant examples. Ask clarifying questions when needed, and ensure your responses are well-structured, helpful, and user-focused.`,
      },
    ];

    // Filter templates by tone or general, excluding used ones
    const availableTemplates = instructionTemplates
      .filter((t) => (t.tone === tone || t.tone === "general") && !usedInstructions.includes(t.text));

    // Fallback to general tone if no specific templates remain
    const finalTemplates = availableTemplates.length > 0
      ? availableTemplates
      : instructionTemplates.filter((t) => t.tone === "general" && !usedInstructions.includes(t.text));

    if (finalTemplates.length === 0) {
      usedInstructions = []; // Reset if all templates used
      finalTemplates.push(...instructionTemplates.filter((t) => t.tone === "general"));
    }

    const selectedInstruction = finalTemplates[Math.floor(Math.random() * finalTemplates.length)].text;
    usedInstructions.push(selectedInstruction);

    setFormData((prev) => ({ ...prev, instructions: selectedInstruction }));
  };

  const generateGreeting = (): void => {
    if (!formData.name || !formData.description) {
      toast.error("Completa nombre y descripción primero");
      return;
    }

    const { tone } = inferContext(formData.description);

    // Reset usedGreetings if all templates are used
    if (usedGreetings.length >= 5) {
      usedGreetings = [];
    }

    const greetingTemplates: Template[] = [
      {
        tone: "technical",
        text: `Hello! I'm ${formData.name}, your go-to expert for ${formData.description.toLowerCase()}. I'm here to provide detailed technical guidance, code snippets, and best practices. What specific challenge or question can I help you with today?`,
      },
      {
        tone: "creative",
        text: `Hi there! I'm ${formData.name}, your creative partner for ${formData.description.toLowerCase()}. I'm excited to help spark ideas and guide you through your project. What's your next creative goal or question?`,
      },
      {
        tone: "professional",
        text: `Greetings! I'm ${formData.name}, specializing in ${formData.description.toLowerCase()}. I'm here to offer strategic insights and practical solutions for your business needs. How can I assist you today?`,
      },
      {
        tone: "conversational",
        text: `Hey there! I'm ${formData.name}, ready to help you with ${formData.description.toLowerCase()}. Whether it's a quick question or a deep dive, I'm here with clear, practical answers. What's on your mind?`,
      },
      {
        tone: "general",
        text: `Welcome! I'm ${formData.name}, your assistant for ${formData.description.toLowerCase()}. I'm here to provide detailed, friendly, and actionable help. What would you like to explore or learn about today?`,
      },
    ];

    // Filter templates by tone or general, excluding used ones
    const availableGreetings = greetingTemplates
      .filter((t) => (t.tone === tone || t.tone === "general") && !usedGreetings.includes(t.text));

    // Fallback to general tone if no specific templates remain
    const finalGreetings = availableGreetings.length > 0
      ? availableGreetings
      : greetingTemplates.filter((t) => t.tone === "general" && !usedGreetings.includes(t.text));

    if (finalGreetings.length === 0) {
      usedGreetings = []; // Reset if all templates used
      finalGreetings.push(...greetingTemplates.filter((t) => t.tone === "general"));
    }

    const selectedGreeting = finalGreetings[Math.floor(Math.random() * finalGreetings.length)].text;
    usedGreetings.push(selectedGreeting);

    setFormData((prev) => ({ ...prev, greetingMessage: selectedGreeting }));
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      if (file.size > 5 * 1024 * 1024) { // 5MB limit
        toast.error("La imagen debe pesar menos de 5MB")
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
      <div className="flex min-h-full items-center justify-center bg-background">
        <div className="text-center">
          <ThinkingIndicator size="lg" className="mx-auto mb-4" />
          <p className="text-sm text-muted-foreground">Cargando GPT...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col bg-[linear-gradient(180deg,#fbfbfb_0%,#f6f7f8_100%)] text-zinc-950 dark:bg-[linear-gradient(180deg,#09090b_0%,#111113_100%)] dark:text-zinc-50">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-white/60 bg-white/70 shadow-[0_8px_28px_-24px_rgba(15,23,42,0.42)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/70">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <SidebarTrigger className="md:hidden" />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.back()}
              className="h-9 w-9 flex-shrink-0 rounded-full text-zinc-500 hover:bg-white/70 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
              aria-label="Volver"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="grid h-9 w-9 flex-shrink-0 place-items-center overflow-hidden rounded-2xl border border-white/70 bg-zinc-950 text-base font-semibold text-white shadow-[0_10px_28px_-18px_rgba(15,23,42,0.85),inset_0_1px_0_rgba(255,255,255,0.26)] dark:border-white/10 dark:bg-white dark:text-zinc-950">
                {uploadedImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={uploadedImage} alt="Avatar" className="h-full w-full object-cover" />
                ) : (
                  <span>{formData.iconUrl || getNameInitial()}</span>
                )}
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold leading-tight sm:text-lg">
                  {isEditMode ? "Editar GPT" : "Crear GPT"}
                </h1>
                <p className="hidden truncate text-xs text-muted-foreground sm:block">
                  {formData.name ? formData.name : "Configuración esencial"}
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsPreviewOpen(true)}
              disabled={!formData.name}
              className={cn("h-9 px-3", liquidGhost)}
            >
              <Eye className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Vista previa</span>
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving || !formData.name}
              size="sm"
              className="h-9 rounded-full bg-zinc-950 px-4 font-medium text-white shadow-[0_14px_30px_-18px_rgba(15,23,42,0.9)] hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              {isSaving ? (
                <span className="flex items-center gap-2">
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Guardando...
                </span>
              ) : isEditMode ? (
                "Actualizar"
              ) : (
                "Crear"
              )}
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto w-full max-w-3xl space-y-5">

          <div className="space-y-1">
            <h2 className="text-xl font-semibold sm:text-2xl">
              {isEditMode ? "Ajusta tu asistente" : "Configura tu asistente"}
            </h2>
            <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
              Completa lo esencial: identidad, instrucciones, modelo y acceso.
            </p>
          </div>

          {/* Basic Information Section */}
          <Card className={liquidPanel}>
            <CardHeader className="gap-1 pb-4">
              <CardTitle className="flex items-center gap-2.5 text-base sm:text-lg">
                <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-2xl border border-white/70 bg-white/70 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/10 dark:bg-white/[0.07] dark:text-zinc-300">
                  <Bot className="h-4 w-4" />
                </span>
                <span>Identidad</span>
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                Nombre, descripción, categoría y avatar.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 sm:space-y-6 pt-0">
              {/* Avatar Selection */}
              <div className="space-y-3">
                <Label className="text-sm font-medium">Avatar</Label>

                <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
                  {/* Avatar Preview */}
                  <div className="relative h-20 w-20 flex-shrink-0">
                    <div className="grid h-full w-full place-items-center overflow-hidden rounded-[22px] border border-white/70 bg-zinc-950 text-3xl font-bold text-white shadow-[0_18px_38px_-24px_rgba(15,23,42,0.9),inset_0_1px_0_rgba(255,255,255,0.24)] dark:border-white/10 dark:bg-white dark:text-zinc-950">
                      {uploadedImage ? (
                        <img src={uploadedImage} alt="Avatar" className="h-full w-full object-cover" />
                      ) : formData.iconUrl ? (
                        <span>{formData.iconUrl}</span>
                      ) : (
                        <span>{getNameInitial()}</span>
                      )}
                    </div>
                    {hasCustomIcon() && (
                      <button
                        type="button"
                        onClick={removeImage}
                        className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full bg-foreground text-background shadow-md transition hover:scale-105"
                        aria-label="Remove avatar"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Controls */}
                  <div className="w-full flex-1 space-y-3">
                    {/* Emoji Options */}
                    <div>
                      <Label className="text-xs text-muted-foreground">Iconos rápidos</Label>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {emojiOptions.map((emoji) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => handleEmojiIcon(emoji)}
                          className={`grid h-9 w-9 place-items-center rounded-2xl border bg-white/65 text-lg shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl transition hover:bg-white/90 dark:bg-white/[0.05] dark:hover:bg-white/[0.1] ${formData.iconUrl === emoji ? 'border-zinc-950 bg-white ring-1 ring-zinc-950/10 dark:border-white dark:bg-white/[0.14]' : 'border-white/65 dark:border-white/10'
                              }`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Upload Image Button */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" className={liquidGhost} asChild>
                        <label htmlFor="icon-upload" className="cursor-pointer">
                          <Upload className="mr-2 h-4 w-4" />
                          Subir imagen
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
                        <Button variant="ghost" size="sm" onClick={removeImage} className="rounded-full text-muted-foreground">
                          Quitar
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Emoji, imagen o inicial del nombre.
                    </p>
                  </div>
                </div>
              </div>

              {/* Name */}
              <div className="space-y-2">
                <Label htmlFor="name" className="text-sm sm:text-base">Nombre *</Label>
                <Input
                  id="name"
                  placeholder="Ej. Revisor de código"
                  value={formData.name}
                  onChange={(e) => handleInputChange("name", e.target.value)}
                  maxLength={100}
                  className={cn("text-sm sm:text-base", liquidField)}
                />
                <div className="text-xs text-muted-foreground">
                  {formData.name.length}/100
                </div>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description" className="text-sm sm:text-base">Descripción *</Label>
                <Textarea
                  id="description"
                  placeholder="Qué hace, para quién sirve y qué resultado entrega."
                  value={formData.description}
                  onChange={(e) => handleInputChange("description", e.target.value)}
                  maxLength={500}
                  rows={3}
                  className={cn("resize-none text-sm sm:text-base", liquidField)}
                />
                <div className="text-xs text-muted-foreground">
                  {formData.description.length}/500
                </div>
              </div>

              {/* Category */}
              <div className="space-y-2">
                <Label htmlFor="category" className="text-sm sm:text-base">Categoría</Label>
                <Select value={formData.category} onValueChange={(value) => handleInputChange("category", value)}>
                  <SelectTrigger className={cn("text-sm sm:text-base", liquidField)}>
                    <SelectValue placeholder="Selecciona una categoría" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((category) => (
                      <SelectItem key={category.name} value={category.name}>
                        <div className="flex items-center gap-2">
                          {category.icon}
                          <span className="text-sm sm:text-base">{category.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Conversation Starters */}
              {/* <div className="space-y-2">
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
              </div> */}
            </CardContent>
          </Card>

          {/* Behavior Configuration Section */}
          <Card className={liquidPanel}>
            <CardHeader className="gap-1 pb-4">
              <CardTitle className="flex items-center gap-2.5 text-base sm:text-lg">
                <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-2xl border border-white/70 bg-white/70 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/10 dark:bg-white/[0.07] dark:text-zinc-300">
                  <MessageSquare className="h-4 w-4" />
                </span>
                <span>Comportamiento</span>
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                Instrucciones claras para respuestas consistentes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 sm:space-y-6 pt-0">
              {/* Instructions */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="instructions">Instrucciones *</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateInstructions}
                    disabled={!formData.name || !formData.description}
                    className={liquidGhost}
                  >
                    <Wand2 className="h-4 w-4 mr-2" />
                    Generar
                  </Button>
                </div>
                <Textarea
                  id="instructions"
                  placeholder="Rol, tono, límites, pasos de trabajo y formato de respuesta."
                  value={formData.instructions}
                  onChange={(e) => handleInputChange("instructions", e.target.value)}
                  rows={8}
                  maxLength={50000}
                  className={liquidField}
                />
                <div className="text-xs text-muted-foreground">
                  {formData.instructions.length}/50000
                </div>
              </div>

              {/* Greeting Message */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="greeting">Mensaje inicial</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateGreeting}
                    disabled={!formData.name || !formData.description}
                    className={liquidGhost}
                  >
                    <Wand2 className="h-4 w-4 mr-2" />
                    Generar
                  </Button>
                </div>
                <Textarea
                  id="greeting"
                  placeholder="Primer mensaje que verá el usuario al iniciar."
                  value={formData.greetingMessage}
                  onChange={(e) => handleInputChange("greetingMessage", e.target.value)}
                  rows={4}
                  maxLength={1000}
                  className={liquidField}
                />
                <div className="text-xs text-muted-foreground">
                  {formData.greetingMessage.length}/1000
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Model Settings Section */}
          <Card className={liquidPanel}>
            <CardHeader className="gap-1 pb-4">
              <CardTitle className="flex items-center gap-2.5 text-base sm:text-lg">
                <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-2xl border border-white/70 bg-white/70 text-zinc-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] dark:border-white/10 dark:bg-white/[0.07] dark:text-zinc-300">
                  <Settings className="h-4 w-4" />
                </span>
                <span>Modelo y acceso</span>
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                Elige el modelo activo y quién puede usarlo.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 sm:space-y-6 pt-0">
              {/* Model Selection */}
              <div className="space-y-2">
                <Label className="text-sm sm:text-base">Modelo *</Label>
                <Select value={formData.modelName} onValueChange={(value) => handleInputChange("modelName", value)}>
                  <SelectTrigger className={cn("text-sm sm:text-base", liquidField)}>
                    <SelectValue placeholder="Selecciona un modelo" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((model) => (
                      <SelectItem key={model.name} value={model.name}>
                        <div className="flex flex-col">
                          <span className="font-medium text-sm sm:text-base">{model.displayName || model.name}</span>
                          {model.description && (
                            <span className="text-xs text-muted-foreground">{model.description}</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {availableModels.length === 0 && (
                  <p className="text-xs text-muted-foreground">Cargando modelos disponibles...</p>
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
                <Label className="text-sm sm:text-base">Visibilidad</Label>
                <Select value={formData.visibility} onValueChange={(value) => handleInputChange("visibility", value as "PRIVATE" | "UNLISTED" | "PUBLIC")}>
                  <SelectTrigger className={cn("text-sm sm:text-base", liquidField)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PRIVATE">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0"></div>
                        <div>
                          <div className="font-medium text-sm sm:text-base">Privado</div>
                          <div className="text-xs text-muted-foreground">Solo tú puedes acceder</div>
                        </div>
                      </div>
                    </SelectItem>
                    <SelectItem value="UNLISTED">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-yellow-500 rounded-full flex-shrink-0"></div>
                        <div>
                          <div className="font-medium text-sm sm:text-base">Por enlace</div>
                          <div className="text-xs text-muted-foreground">Accesible solo con link</div>
                        </div>
                      </div>
                    </SelectItem>
                    <SelectItem value="PUBLIC">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0"></div>
                        <div>
                          <div className="font-medium text-sm sm:text-base">Público</div>
                          <div className="text-xs text-muted-foreground">Visible para todos</div>
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

      {/* Sticky action bar — keeps the primary save action reachable at all times */}
      <div className="sticky bottom-0 z-30 border-t border-white/60 bg-white/72 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/72">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <p className="hidden text-xs text-muted-foreground sm:block">
            {formData.name ? "Listo para guardar." : "El nombre es obligatorio."}
          </p>
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <Button variant="ghost" onClick={() => router.back()} className="h-10 rounded-full px-4 text-zinc-500 hover:text-zinc-950 dark:hover:text-white">
              Cancelar
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving || !formData.name}
              className="h-10 flex-1 rounded-full bg-zinc-950 px-6 font-medium text-white shadow-[0_16px_32px_-18px_rgba(15,23,42,0.9)] hover:bg-zinc-800 sm:flex-none dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              {isSaving ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Guardando...
                </span>
              ) : isEditMode ? (
                "Actualizar GPT"
              ) : (
                "Crear GPT"
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Preview Dialog */}
      <Dialog open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <DialogContent className="mx-auto max-w-2xl rounded-[28px] border-white/60 bg-white/82 p-4 shadow-[0_24px_70px_-36px_rgba(15,23,42,0.55)] backdrop-blur-2xl sm:p-6 dark:border-white/10 dark:bg-zinc-950/82">
          <DialogHeader className="pb-4">
            <DialogTitle className="text-lg sm:text-xl">Vista previa</DialogTitle>
            <DialogDescription className="text-sm">
              Así se verá tu GPT en la biblioteca.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* GPT Card Preview */}
            <div className="rounded-[22px] border border-white/65 bg-white/75 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl sm:p-4 md:p-6 dark:border-white/10 dark:bg-white/[0.055]">
              <div className="flex items-start space-x-3 sm:space-x-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl text-lg font-bold sm:h-12 sm:w-12 sm:text-xl">
                  {uploadedImage ? (
                    <img
                      src={uploadedImage}
                      alt="Avatar"
                      className="w-full h-full object-cover rounded-full"
                    />
                  ) : formData.iconUrl ? (
                    <div className="flex h-full w-full items-center justify-center rounded-2xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                      {formData.iconUrl}
                    </div>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center rounded-2xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                      {getNameInitial()}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-foreground mb-1 text-sm sm:text-base truncate">
                    {formData.name || "Untitled GPT"}
                  </h3>
                  <p className="text-muted-foreground text-xs sm:text-sm mb-2 line-clamp-2">
                    {formData.description || "No description"}
                  </p>
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex items-center flex-wrap gap-2 sm:gap-4 text-xs text-muted-foreground">
                      <span className="truncate">Por {user?.name || 'ti'}</span>
                      <div className="flex items-center space-x-1 flex-shrink-0">
                        <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                        <span>Nuevo</span>
                      </div>
                    </div>
                    <Button size="sm" className="self-start rounded-full bg-zinc-950 px-3 py-1 text-xs text-white hover:bg-zinc-800 sm:self-auto dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200">
                      Chat
                    </Button>
                  </div>
                </div>
              </div>

              {formData.category && (
                <Badge variant="outline" className="mt-3 text-xs">
                  {formData.category}
                </Badge>
              )}
            </div>

            {/* Greeting Preview */}
            {formData.greetingMessage && (
              <Card className={liquidPanel}>
                <CardContent className="pt-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-2xl bg-zinc-950 text-sm text-white dark:bg-white dark:text-zinc-950">
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
            {/* {formData.conversationStarters.filter(s => s.trim()).length > 0 && (
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
            )} */}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
