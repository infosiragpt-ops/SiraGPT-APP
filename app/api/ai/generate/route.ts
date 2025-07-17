// import { NextRequest, NextResponse } from 'next/server'
// import { validateSession } from '@/lib/auth'
// import { prisma } from '@/lib/prisma'
// import { z } from 'zod'

// const generateSchema = z.object({
//   model: z.string().min(1, 'Model is required'),
//   prompt: z.string().min(1, 'Prompt is required'),
//   chatId: z.string().optional(),
// })

// // AI Service Integration
// async function generateAIResponse(model: string, prompt: string): Promise<{ content: string; tokens: number }> {
//   // This is where you'd integrate with actual AI services
//   // For now, we'll simulate a response

//   const responses = [
//     `Hello! I'm ${model}. I understand you're asking about: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}". Here's my response based on my training data.`,
//     `That's an interesting question! As ${model}, I can help you with that. Let me provide you with a comprehensive answer.`,
//     `Great question! Using ${model}, I can analyze this topic and provide you with detailed insights.`,
//     `I'd be happy to help you with that inquiry. Based on my knowledge as ${model}, here's what I can tell you.`,
//     `Thank you for your question. As an AI assistant powered by ${model}, I'll do my best to provide you with accurate information.`,
//   ]

//   // Simulate API delay
//   await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000))

//   const content = responses[Math.floor(Math.random() * responses.length)]
//   const tokens = content.length + prompt.length

//   return { content, tokens }
// }

// export async function POST(request: NextRequest) {
//   try {
//     const token = request.headers.get('authorization')?.replace('Bearer ', '') ||
//                   request.cookies.get('auth-token')?.value

//     if (!token) {
//       return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
//     }

//     const user = await validateSession(token)
//     if (!user) {
//       return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
//     }

//     const body = await request.json()
//     const { model, prompt, chatId } = generateSchema.parse(body)

//     // Check user's monthly limit
//     if (user.apiUsage >= user.monthlyLimit) {
//       return NextResponse.json(
//         { error: 'Monthly API limit exceeded' },
//         { status: 429 }
//       )
//     }

//     // Generate AI response
//     const { content, tokens } = await generateAIResponse(model, prompt)

//     // If chatId is provided, save messages to chat
//     if (chatId) {
//       // Verify chat belongs to user
//       const chat = await prisma.chat.findFirst({
//         where: {
//           id: chatId,
//           userId: user.id,
//         },
//       })

//       if (!chat) {
//         return NextResponse.json({ error: 'Chat not found' }, { status: 404 })
//       }

//       // Save user message
//       await prisma.message.create({
//         data: {
//           chatId,
//           role: 'USER',
//           content: prompt,
//         },
//       })

//       // Save assistant message
//       await prisma.message.create({
//         data: {
//           chatId,
//           role: 'ASSISTANT',
//           content,
//           tokens,
//         },
//       })

//       // Update chat
//       await prisma.chat.update({
//         where: { id: chatId },
//         data: { 
//           updatedAt: new Date(),
//           title: chat.title === 'New Chat' ? prompt.slice(0, 50) + (prompt.length > 50 ? '...' : '') : chat.title,
//         },
//       })
//     }

//     // Track API usage
//     await prisma.apiUsage.create({
//       data: {
//         userId: user.id,
//         model,
//         tokens,
//         cost: tokens * 0.001,
//       },
//     })

//     // Update user's API usage
//     await prisma.user.update({
//       where: { id: user.id },
//       data: {
//         apiUsage: {
//           increment: tokens,
//         },
//       },
//     })

//     return NextResponse.json({
//       content,
//       tokens,
//       usage: {
//         current: user.apiUsage + tokens,
//         limit: user.monthlyLimit,
//       },
//     })
//   } catch (error) {
//     console.error('AI generation error:', error)

//     if (error instanceof z.ZodError) {
//       return NextResponse.json(
//         { error: error.errors[0].message },
//         { status: 400 }
//       )
//     }

//     return NextResponse.json(
//       { error: 'Internal server error' },
//       { status: 500 }
//     )
//   }
// }

import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'

const generateSchema = z.object({
  model: z.string().min(1, 'Model is required'),
  prompt: z.string().min(1, 'Prompt is required'),
  chatId: z.string().optional(),
  files: z.array(z.any()).optional(),
  apiKey: z.string().optional(),
})

// Real AI API Integration
async function generateAIResponse(
  model: string,
  prompt: string,
  files?: any[],
  apiKey?: string
): Promise<{ content: string; tokens: number; images?: string[] }> {

  // Check if API key is provided for real AI integration
  if (apiKey) {
    try {
      if (model.toLowerCase().includes('gpt') || model.toLowerCase().includes('chatgpt')) {
        return await callOpenAI(model, prompt, apiKey, files)
      } else if (model.toLowerCase().includes('claude')) {
        return await callAnthropic(model, prompt, apiKey, files)
      }
    } catch (error) {
      console.error('AI API call failed:', error)
      return {
        content: `Error calling ${model} API: ${error}. Please check your API key.`,
        tokens: 0
      }
    }
  }

  // Simulated response (fallback when no API key)
  let fileContext = ''
  if (files && files.length > 0) {
    fileContext = files.map(file => {
      if (file.extractedText) {
        return `\n\nFile: ${file.name}\nContent: ${file.extractedText.slice(0, 200)}...`
      }
      return `\n\nFile: ${file.name} (${file.type})`
    }).join('')
  }

  const responses = [
    `Hello! I'm ${model}. I understand you're asking about: "${prompt.slice(0, 50)}${prompt.length > 50 ? "..." : ""}". Here's my response based on my training data.${fileContext}`,
    `That's an interesting question! As ${model}, I can help you with that. Let me provide you with a comprehensive answer.${fileContext}`,
    `Great question! Using ${model}, I can analyze this topic and provide you with detailed insights.${fileContext}`,
    `I'd be happy to help you with that inquiry. Based on my knowledge as ${model}, here's what I can tell you.${fileContext}`,
    `Thank you for your question. As an AI assistant powered by ${model}, I'll do my best to provide you with accurate information.${fileContext}`,
  ]

  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000))

  const content = responses[Math.floor(Math.random() * responses.length)]
  const tokens = content.length + prompt.length

  return { content, tokens }
}

async function callOpenAI(model: string, prompt: string, apiKey: string, files?: any[]) {
  const messages: any[] = []

  // Add file context
  if (files && files.length > 0) {
    const fileContext = files.map(file => {
      if (file.extractedText) {
        return `File: ${file.name}\nContent: ${file.extractedText}`
      }
      return `File: ${file.name} (${file.type})`
    }).join('\n\n')

    messages.push({
      role: "system",
      content: `You have access to the following files:\n\n${fileContext}\n\nUse this information to answer the user's questions.`
    })
  }

  // Add user message with image support
  const userMessage: any = {
    role: "user",
    content: []
  }

  userMessage.content.push({
    type: "text",
    text: prompt
  })

  // Add images if present
  if (files) {
    files.forEach(file => {
      if (file.type?.startsWith('image/') && file.url) {
        userMessage.content.push({
          type: "image_url",
          image_url: {
            url: file.url
          }
        })
      }
    })
  }

  messages.push(userMessage)

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model.includes("vision") ? "gpt-4-vision-preview" : "gpt-4",
      messages: messages,
      max_tokens: 2000,
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || `OpenAI API error: ${response.statusText}`)
  }

  const data = await response.json()
  return {
    content: data.choices[0].message.content,
    tokens: data.usage?.total_tokens || 0
  }
}

async function callAnthropic(model: string, prompt: string, apiKey: string, files?: any[]) {
  let fullPrompt = prompt

  if (files && files.length > 0) {
    const fileContext = files.map(file => {
      if (file.extractedText) {
        return `File: ${file.name}\nContent: ${file.extractedText}`
      }
      return `File: ${file.name} (${file.type})`
    }).join('\n\n')

    fullPrompt = `Context from uploaded files:\n\n${fileContext}\n\nUser question: ${prompt}`
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-sonnet-20240229",
      max_tokens: 2000,
      messages: [{ role: "user", content: fullPrompt }],
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || `Anthropic API error: ${response.statusText}`)
  }

  const data = await response.json()
  return {
    content: data.content[0].text,
    tokens: data.usage?.input_tokens + data.usage?.output_tokens || 0
  }
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
    const { model, prompt, chatId, files, apiKey } = generateSchema.parse(body)

    // Check user's monthly limit
    if (user.apiUsage >= user.monthlyLimit) {
      return NextResponse.json(
        {
          error: 'Monthly API limit exceeded',
          usage: {
            current: user.apiUsage,
            limit: user.monthlyLimit
          }
        },
        { status: 429 }
      )
    }

    // Generate AI response
    const { content, tokens, images } = await generateAIResponse(model, prompt, files, apiKey)

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
          files: files ? JSON.stringify(files) : null,
        },
      })

      // Save assistant message
      await prisma.message.create({
        data: {
          chatId,
          role: 'ASSISTANT',
          content,
          tokens,
          files: images ? JSON.stringify(images.map(img => ({ type: 'image', url: img }))) : null,
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
    const updatedUser = await prisma.user.update({
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
      images,
      files: files || [],
      usage: {
        current: updatedUser.apiUsage,
        limit: updatedUser.monthlyLimit,
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
      { error: 'Failed to generate AI response' },
      { status: 500 }
    )
  }
}