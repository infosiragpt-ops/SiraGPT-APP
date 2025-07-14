import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { validateSession } from '@/lib/auth'
import { z } from 'zod'

const createMessageSchema = z.object({
  role: z.enum(['USER', 'ASSISTANT']),
  content: z.string().min(1, 'Content is required'),
  tokens: z.number().optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

    // Verify chat belongs to user
    const chat = await prisma.chat.findFirst({
      where: {
        id: params.id,
        userId: user.id,
      },
    })

    if (!chat) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 })
    }

    const body = await request.json()
    const { role, content, tokens } = createMessageSchema.parse(body)

    const message = await prisma.message.create({
      data: {
        chatId: params.id,
        role,
        content,
        tokens,
      },
    })

    // Update chat's updatedAt timestamp
    await prisma.chat.update({
      where: { id: params.id },
      data: { updatedAt: new Date() },
    })

    // Track API usage if it's an assistant message
    if (role === 'ASSISTANT' && tokens) {
      await prisma.apiUsage.create({
        data: {
          userId: user.id,
          model: chat.model,
          tokens,
          cost: tokens * 0.001, // Example cost calculation
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
    }

    return NextResponse.json({ message })
  } catch (error) {
    console.error('Create message error:', error)
    
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