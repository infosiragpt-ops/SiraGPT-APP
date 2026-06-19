"use client"

import * as React from "react"
import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  Eye,
  Upload,
  X,
  Wand2,
  Globe,
  ImageIcon,
  Code,
  Palette,
  Plus,
  Mic,
  ArrowUp,
  Star} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent } from "@/components/ui/card"
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
      webBrowsing: true,
      dataAnalysis: true,
      imageGeneration: true,
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
          webBrowsing: gpt.capabilities?.webBrowsing ?? false,
          dataAnalysis: gpt.capabilities?.dataAnalysis ?? false,
          imageGeneration: gpt.capabilities?.imageGeneration ?? false,
          codeInterpreter: gpt.capabilities?.codeInterpreter ?? false,
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
      <header className="sticky top-0 z-30 border-b border-black/[0.06] bg-white/80 backdrop-blur-xl dark:border-white/10 dark:bg-zinc-950/80">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <SidebarTrigger className="md:hidden" />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.back()}
              className="h-9 w-9 flex-shrink-0 rounded-full text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
              aria-label="Volver"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="grid h-9 w-9 flex-shrink-0 place-items-center overflow-hidden rounded-full border border-black/[0.06] bg-zinc-950 text-base font-semibold text-white dark:border-white/10 dark:bg-white dark:text-zinc-950">
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
                  {formData.name ? formData.name : "Borrador"}
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {/* Mobile preview opens the Dialog */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsPreviewOpen(true)}
              disabled={!formData.name}
              className={cn("h-9 px-3 lg:hidden", liquidGhost)}
            >
              <Eye className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Vista previa</span>
            </Button>
            <Button
              onClick={handleSave}
              disabled={isSaving || !formData.name}
              size="sm"
              className="h-9 rounded-full bg-zinc-950 px-4 font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              {isSaving ? (
                <span className="flex items-center gap-2">
                  <ThinkingIndicator size="xs" />
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

        {/* Tabs */}
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <button
              type="button"
              disabled
              title="Próximamente"
              className="cursor-not-allowed border-b-2 border-transparent pb-2.5 pt-0.5 text-sm font-medium text-zinc-400 dark:text-zinc-600"
            >
              Crear
            </button>
            <button
              type="button"
              className="-mb-px border-b-2 border-zinc-950 pb-2.5 pt-0.5 text-sm font-medium text-zinc-950 dark:border-white dark:text-white"
            >
              Configurar
            </button>
          </div>
        </div>
      </header>

      {/* Two-pane builder */}
      <div className="flex-1">
        <div className="mx-auto w-full max-w-6xl lg:grid lg:grid-cols-2 lg:gap-0">

          {/* LEFT — Configurar (form) */}
          <div className="px-4 py-6 sm:px-6 sm:py-8 lg:border-r lg:border-black/[0.06] dark:lg:border-white/10">
            <div className="mx-auto w-full max-w-xl space-y-6">

              {/* Avatar */}
              <div className="flex flex-col items-center gap-3">
                <div className="relative h-24 w-24">
                  <label
                    htmlFor="icon-upload"
                    className="grid h-full w-full cursor-pointer place-items-center overflow-hidden rounded-full border border-dashed border-black/15 bg-white text-3xl font-semibold text-zinc-700 transition hover:border-black/30 hover:bg-zinc-50 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-white/30 dark:hover:bg-zinc-800"
                  >
                    {uploadedImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={uploadedImage} alt="Avatar" className="h-full w-full object-cover" />
                    ) : formData.iconUrl ? (
                      <span>{formData.iconUrl}</span>
                    ) : formData.name ? (
                      <span>{getNameInitial()}</span>
                    ) : (
                      <Plus className="h-7 w-7 text-zinc-400" />
                    )}
                  </label>
                  {hasCustomIcon() && (
                    <button
                      type="button"
                      onClick={removeImage}
                      className="absolute -right-1 -top-1 grid h-6 w-6 place-items-center rounded-full bg-zinc-950 text-white shadow-md transition hover:scale-105 dark:bg-white dark:text-zinc-950"
                      aria-label="Quitar avatar"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <input
                    id="icon-upload"
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </div>
                {/* Quick emoji icons */}
                <div className="flex flex-wrap justify-center gap-1.5">
                  {emojiOptions.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => handleEmojiIcon(emoji)}
                      className={cn(
                        "grid h-8 w-8 place-items-center rounded-lg border text-base transition hover:bg-zinc-50 dark:hover:bg-zinc-800",
                        formData.iconUrl === emoji
                          ? "border-zinc-950 bg-zinc-50 dark:border-white dark:bg-zinc-800"
                          : "border-black/[0.08] bg-white dark:border-white/10 dark:bg-zinc-900"
                      )}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>

              {/* Name */}
              <div className="space-y-2">
                <Label htmlFor="name" className="text-sm font-medium">Nombre</Label>
                <Input
                  id="name"
                  placeholder="Ej. Revisor de código"
                  value={formData.name}
                  onChange={(e) => handleInputChange("name", e.target.value)}
                  maxLength={100}
                  className={cn("text-sm", liquidField)}
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description" className="text-sm font-medium">Descripción</Label>
                <Input
                  id="description"
                  placeholder="Añade una descripción breve sobre lo que hace este GPT"
                  value={formData.description}
                  onChange={(e) => handleInputChange("description", e.target.value)}
                  maxLength={500}
                  className={cn("text-sm", liquidField)}
                />
              </div>

              {/* Instructions */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="instructions" className="text-sm font-medium">Instrucciones</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={generateInstructions}
                    disabled={!formData.name || !formData.description}
                    className="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-950 dark:hover:text-white"
                  >
                    <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                    Generar
                  </Button>
                </div>
                <Textarea
                  id="instructions"
                  placeholder="¿Qué hace este GPT? ¿Cómo se comporta? ¿Qué debe evitar?"
                  value={formData.instructions}
                  onChange={(e) => handleInputChange("instructions", e.target.value)}
                  rows={8}
                  maxLength={50000}
                  className={cn("text-sm", liquidField)}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Las conversaciones con tu GPT pueden potencialmente incluir todas las instrucciones o parte de ellas.
                </p>
              </div>

              {/* Conversation Starters */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Frases para iniciar una conversación</Label>
                <div className="space-y-2">
                  {formData.conversationStarters.map((starter, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input
                        placeholder="Ej. «Ayúdame a redactar un correo profesional»"
                        value={starter}
                        onChange={(e) => handleConversationStarterChange(index, e.target.value)}
                        maxLength={200}
                        className={cn("text-sm", liquidField)}
                      />
                      {formData.conversationStarters.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeConversationStarter(index)}
                          className="h-9 w-9 flex-shrink-0 rounded-lg text-zinc-400 hover:text-zinc-950 dark:hover:text-white"
                          aria-label="Quitar frase"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                  {formData.conversationStarters.length < 4 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={addConversationStarter}
                      className={cn("w-full justify-center", liquidGhost)}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Añadir frase
                    </Button>
                  )}
                </div>
              </div>

              {/* Conocimientos */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Conocimientos</Label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Si subes archivos en Conocimientos, las conversaciones con tu GPT pueden potencialmente revelar todos los archivos o parte de su contenido. Las funciones que requieran intérprete de código permiten la descarga de los archivos.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className={liquidGhost}
                    onClick={() => toast.info("Subida de archivos de conocimiento — próximamente")}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Cargar archivos
                  </Button>
                </div>
              </div>

              {/* Modelo recomendado */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Modelo recomendado</Label>
                <Select value={formData.modelName} onValueChange={(value) => handleInputChange("modelName", value)}>
                  <SelectTrigger className={cn("text-sm", liquidField)}>
                    <SelectValue placeholder="Selecciona un modelo" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableModels.map((model) => (
                      <SelectItem key={model.name} value={model.name}>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">{model.displayName || model.name}</span>
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

              {/* Funcionalidades — per-GPT tool capabilities (ChatGPT-style) */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Funcionalidades</Label>
                <p className="text-xs text-muted-foreground">Elige qué herramientas puede usar este GPT.</p>
                <div className="mt-1 overflow-hidden rounded-lg border border-border/60 bg-background/40">
                  {([
                    { key: "webBrowsing", icon: Globe, label: "Búsqueda en la web", desc: "Consulta información actualizada en internet." },
                    { key: "dataAnalysis", icon: Palette, label: "Lienzo", desc: "Crea y edita documentos y diagramas." },
                    { key: "imageGeneration", icon: ImageIcon, label: "Generación de imagen", desc: "Genera imágenes a partir de texto." },
                    { key: "codeInterpreter", icon: Code, label: "Intérprete de código y análisis de datos", desc: "Ejecuta código y analiza archivos." },
                  ] as { key: keyof GPTFormData["capabilities"]; icon: any; label: string; desc: string }[]).map((cap) => {
                    const Icon = cap.icon
                    return (
                      <label
                        key={cap.key}
                        htmlFor={`cap-${cap.key}`}
                        className="flex cursor-pointer select-none items-center gap-3 border-t border-border/50 px-3 py-3 transition-colors first:border-t-0 hover:bg-muted/40"
                      >
                        <Checkbox
                          id={`cap-${cap.key}`}
                          checked={formData.capabilities[cap.key]}
                          onCheckedChange={(checked) => handleCapabilityChange(cap.key, checked === true)}
                        />
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium leading-tight text-foreground">{cap.label}</span>
                          <span className="mt-0.5 block text-xs leading-tight text-muted-foreground">{cap.desc}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>

              {/* Acciones */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Acciones</Label>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("w-full justify-center", liquidGhost)}
                  type="button"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Crear nueva acción
                </Button>
              </div>

            </div>
          </div>

          {/* RIGHT — Vista previa (live, desktop only) */}
          <div className="hidden bg-[#fafafa] dark:bg-zinc-900/40 lg:flex lg:min-h-[calc(100vh-7rem)] lg:flex-col">
            <div className="flex flex-1 flex-col px-6 py-8">
              <p className="mb-6 text-center text-sm font-medium text-zinc-500 dark:text-zinc-400">Vista previa</p>

              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <div className="grid h-20 w-20 place-items-center overflow-hidden rounded-full border border-black/[0.06] bg-zinc-950 text-3xl font-semibold text-white dark:border-white/10 dark:bg-white dark:text-zinc-950">
                  {uploadedImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={uploadedImage} alt="Avatar" className="h-full w-full object-cover" />
                  ) : formData.iconUrl ? (
                    <span>{formData.iconUrl}</span>
                  ) : (
                    <span>{getNameInitial()}</span>
                  )}
                </div>
                <h2 className="mt-4 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
                  {formData.name || "Nuevo GPT"}
                </h2>
                <p className="mt-1.5 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                  {formData.description || "Añade una descripción breve sobre lo que hace este GPT"}
                </p>

                {formData.conversationStarters.filter((s) => s.trim()).length > 0 && (
                  <div className="mt-6 grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-2">
                    {formData.conversationStarters.filter((s) => s.trim()).map((starter, index) => (
                      <div
                        key={index}
                        className="rounded-xl border border-black/[0.06] bg-white px-3 py-2.5 text-left text-sm text-zinc-700 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300"
                      >
                        {starter}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Composer-style placeholder (decorative) */}
              <div className="mx-auto mt-6 w-full max-w-md">
                <div className="flex items-center gap-2 rounded-full border border-black/[0.08] bg-white px-3 py-2 dark:border-white/10 dark:bg-zinc-900">
                  <Plus className="h-5 w-5 flex-shrink-0 text-zinc-400" />
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-400">Empieza por definir tu GPT.</span>
                  <Mic className="h-5 w-5 flex-shrink-0 text-zinc-400" />
                  <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                    <ArrowUp className="h-4 w-4" />
                  </span>
                </div>
              </div>
            </div>
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
