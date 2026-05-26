"use client"

import mammoth from "mammoth"
import { createWorker } from "tesseract.js"
import { readXlsxWorkbook, xlsxRowToValues } from "./xlsx-client"

export interface DocumentProcessor {
  processWord: (file: File) => Promise<string>
  processExcel: (file: File) => Promise<string>
  processPowerPoint: (file: File) => Promise<string>
  processImage: (file: File) => Promise<string>
  processPDF: (file: File) => Promise<string>
}

class DocumentProcessorImpl implements DocumentProcessor {
  async processWord(file: File): Promise<string> {
    try {
      const arrayBuffer = await file.arrayBuffer()
      const result = await mammoth.extractRawText({ arrayBuffer })
      return result.value
    } catch (error) {
      console.error("Error processing Word document:", error)
      throw new Error("Failed to process Word document")
    }
  }

  async processExcel(file: File): Promise<string> {
    try {
      const arrayBuffer = await file.arrayBuffer()
      const workbook = await readXlsxWorkbook(arrayBuffer)
      let text = ""

      workbook.worksheets.forEach((worksheet: any) => {
        text += `Sheet: ${worksheet.name}\n`
        worksheet.eachRow({ includeEmpty: false }, (row: any) => {
          text += xlsxRowToValues(row).join("\t") + "\n"
        })
        text += "\n"
      })

      return text
    } catch (error) {
      console.error("Error processing Excel document:", error)
      throw new Error("Failed to process Excel document")
    }
  }

  async processPowerPoint(file: File): Promise<string> {
    try {
      // For now, return a placeholder as PowerPoint processing is complex
      // In a real implementation, you'd use a library like node-pptx or similar
      return `PowerPoint file "${file.name}" uploaded. Content extraction for PowerPoint files will be implemented in the next version.`
    } catch (error) {
      console.error("Error processing PowerPoint document:", error)
      throw new Error("Failed to process PowerPoint document")
    }
  }

  async processImage(file: File): Promise<string> {
    try {
      const worker = await createWorker("eng")
      const {
        data: { text },
      } = await worker.recognize(file)
      await worker.terminate()
      return text
    } catch (error) {
      console.error("Error processing image with OCR:", error)
      throw new Error("Failed to process image with OCR")
    }
  }

  async processPDF(file: File): Promise<string> {
    try {
      // PDF processing would require pdf-parse or similar library
      // For now, return a placeholder
      return `PDF file "${file.name}" uploaded. PDF text extraction will be implemented in the next version.`
    } catch (error) {
      console.error("Error processing PDF document:", error)
      throw new Error("Failed to process PDF document")
    }
  }
}

export const documentProcessor = new DocumentProcessorImpl()
