import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'

const generateSchema = z.object({
  model: z.string().min(1, 'Model is required'),
  prompt: z.string().min(1, 'Prompt is required'),
  chatId: z.string().optional(),
})

// AI Service Integration
async function generateAIResponse(model: string, prompt: string): Promise<{ content: string; tokens: number }> {
  // This is where you'd integrate with actual AI services
  // For now, we'll simulate a response
  
  const responses = [
    `Hello! I'm ${model}. I understand you're asking about: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}". Here's my response based on my training data.`,
    `That's an interesting question! As ${model}, I can help you with that. Let me provide you with a comprehensive answer.`,
    `Great question! Using ${model}, I can analyze this topic and provide you with detailed insights.`,
    `I'd be happy to help you with that inquiry. Based on my knowledge as ${model}, here's what I can tell you.`,
    `Thank you for your question. As an AI assistant powered by ${model}, I'll do my best to provide you with accurate information.`,
  ]

  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000))

  const content = responses[Math.floor(Math.random() * responses.length)]
  const tokens = content.length + prompt.length

  return { content, tokens }
}

export async function POST(request: NextRequest) {
  try {
    const token = request.headers.get('authorization')?.replace('Bearer ', '') ||
                  request.cookies.get('auth-token')?.value

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await validateSession(token)
    if (!user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const body = await request.json()
    const { model, prompt, chatId } = generateSchema.parse(body)

    // Check user's monthly limit
    if (user.apiUsage >= user.monthlyLimit) {
      return NextResponse.json(
        { error: 'Monthly API limit exceeded' },
        { status: 429 }
      )
    }

    // Generate AI response
    const { content, tokens } = await generateAIResponse(model, prompt)

    // If chatId is provided, save messages to chat
    if (chatId) {
      // Verify chat belongs to user
      const chat = await prisma.chat.findFirst({
        where: {
          id: chatId,
          userId: user.id,
        },
      })

      if (!chat) {
        return NextResponse.json({ error: 'Chat not found' }, { status: 404 })
      }

      // Save user message
      await prisma.message.create({
        data: {
          chatId,
          role: 'USER',
          content: prompt,
        },
      })

      // Save assistant message
      await prisma.message.create({
        data: {
          chatId,
          role: 'ASSISTANT',
          content,
          tokens,
        },
      })

      // Update chat
      await prisma.chat.update({
        where: { id: chatId },
        data: { 
          updatedAt: new Date(),
          title: chat.title === 'New Chat' ? prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '') : chat.title,
        },
      })
    }

    // Track API usage
    await prisma.apiUsage.create({
      data: {
        userId: user.id,
        model,
        tokens,
        cost: tokens * 0.001,
      },
    })

    // Update user's API usage
    await prisma.user.update({
      where: { id: user.id },
      data: {
        apiUsage: {
          increment: tokens,
        },
      },
    })

    return NextResponse.json({
      content,
      tokens,
      usage: {
        current: user.apiUsage + tokens,
        limit: user.monthlyLimit,
      },
    })
  } catch (error) {
    console.error('AI generation error:', error)
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}