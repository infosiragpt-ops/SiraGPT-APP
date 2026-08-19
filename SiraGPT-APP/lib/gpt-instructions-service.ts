"use client"

export interface GPTInstruction {
  id: string
  title: string
  instruction: string
  category: string
}

export const predefinedInstructions: GPTInstruction[] = [
  {
    id: "1",
    title: "Code Review",
    instruction:
      "Please review the following code and provide suggestions for improvement, focusing on best practices, performance, and readability.",
    category: "Development",
  },
  {
    id: "2",
    title: "Document Summarization",
    instruction:
      "Please summarize the following document in 3-5 key points, highlighting the most important information.",
    category: "Analysis",
  },
  {
    id: "3",
    title: "Email Writing",
    instruction: "Please help me write a professional email with the following context and requirements:",
    category: "Communication",
  },
  {
    id: "4",
    title: "Data Analysis",
    instruction: "Please analyze the following data and provide insights, trends, and recommendations:",
    category: "Analysis",
  },
  {
    id: "5",
    title: "Creative Writing",
    instruction: "Please help me write a creative piece with the following theme and style requirements:",
    category: "Creative",
  },
  {
    id: "6",
    title: "Technical Documentation",
    instruction: "Please help me create technical documentation for the following system/process:",
    category: "Documentation",
  },
  {
    id: "7",
    title: "Problem Solving",
    instruction: "Please help me solve the following problem step by step, showing your reasoning:",
    category: "Problem Solving",
  },
  {
    id: "8",
    title: "Language Translation",
    instruction: "Please translate the following text and provide context about cultural nuances if relevant:",
    category: "Language",
  },
]

export class GPTInstructionsService {
  getInstructions(): GPTInstruction[] {
    return predefinedInstructions
  }

  getInstructionsByCategory(category: string): GPTInstruction[] {
    return predefinedInstructions.filter((instruction) => instruction.category === category)
  }

  getCategories(): string[] {
    return [...new Set(predefinedInstructions.map((instruction) => instruction.category))]
  }

  generateCustomInstruction(context: string, task: string): string {
    return `Based on the context: "${context}", please help me with the following task: "${task}". Please provide a detailed and structured response.`
  }
}

export const gptInstructionsService = new GPTInstructionsService()
