export type DocumentChatFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'csv' | 'html' | 'md'
export type DocumentChatComplexity = 'simple' | 'standard' | 'high' | 'stress'

export interface DocumentChatRequestInput {
  prompt: string
  chatId?: string
  model?: string
  fileIds?: string[]
}

export interface DocumentChatRequest {
  prompt: string
  displayPrompt: string
  chatId?: string
  model?: string
  format: DocumentChatFormat
  template: string
  complexity: DocumentChatComplexity
  files?: string[]
}

const normalize = (value: string) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const DOCUMENT_EDITING_POLICY = [
  'SiraGPT document editing policy:',
  '- If uploaded files are present and the user says "mi Word", "mi Excel", "en su Excel", "este documento", or asks to modify/improve/rewrite/fix content, treat the uploaded file as the source document to preserve.',
  '- Never overwrite or mutate the original upload. Always generate a new downloadable file in the same format unless the user explicitly asks for a different format.',
  '- Preserve the original structure as much as the available renderer allows: logos/images, tables, sheet names, formulas, styles, section order, headers, footers, and slide layout.',
  '- Make only the requested edits; do not redesign unrelated parts of the file.',
  '- When exact binary/layout preservation is not technically possible, state the limitation briefly and still return the best reconstructed editable document.',
].join('\n')

function withDocumentEditingPolicy(prompt: string, fileIds: string[]) {
  if (fileIds.length === 0) return prompt
  return `${prompt}\n\n---\n${DOCUMENT_EDITING_POLICY}`
}

export function detectDocumentChatFormat(prompt: string): DocumentChatFormat {
  const text = normalize(prompt)
  if (/\b(xlsx?|excel|hoja de calculo|spreadsheet|dashboard)\b/.test(text)) return 'xlsx'
  if (/\b(pptx?|ppt\b|power\s*point|powerpoint|presentacion|diapositivas|slides?)\b/.test(text)) return 'pptx'
  if (/\b(pdf)\b/.test(text)) return 'pdf'
  if (/\b(csv)\b/.test(text)) return 'csv'
  if (/\b(html|pagina html|documento web)\b/.test(text)) return 'html'
  if (/\b(markdown|md)\b/.test(text)) return 'md'
  return 'docx'
}

export function detectDocumentChatTemplate(prompt: string): string {
  const text = normalize(prompt)
  if (/\b(tesis|apa|academico|investigacion|articulos?|cientificos?|marco teorico)\b/.test(text)) return 'academic'
  if (/\b(contrato|legal|clausula|acuerdo|expediente)\b/.test(text)) return 'legal'
  if (/\b(financier|ventas|mercado|dashboard|kpi|empresa|ejecutiv|propuesta comercial)\b/.test(text)) return 'business'
  if (/\b(educativ|curso|clase|examen|rubrica)\b/.test(text)) return 'education'
  return 'premium'
}

export function detectDocumentChatComplexity(prompt: string, fileIds: string[] = []): DocumentChatComplexity {
  const text = normalize(prompt)
  if (/\b(estres|stress|extremadamente complejo|alta complejidad|100 paginas|mil registros|miles de registros)\b/.test(text)) return 'stress'
  if (
    fileIds.length > 0
    || /\b(extenso|tesis|apa 7|dashboard|graficos?|formulas?|anexos?|indice|referencias|multiples hojas|presentacion ejecutiva|contrato)\b/.test(text)
  ) {
    return 'high'
  }
  if (/\b(simple|breve|rapido|corto|chiste)\b/.test(text)) return 'simple'
  return 'standard'
}

export function buildDocumentChatRequest(input: DocumentChatRequestInput): DocumentChatRequest {
  const prompt = String(input.prompt || '').trim()
  const fileIds = Array.from(new Set((input.fileIds || []).filter(Boolean)))
  const executionPrompt = withDocumentEditingPolicy(prompt, fileIds)
  const request: DocumentChatRequest = {
    prompt: executionPrompt,
    displayPrompt: prompt,
    chatId: input.chatId,
    model: input.model,
    format: detectDocumentChatFormat(prompt),
    template: detectDocumentChatTemplate(prompt),
    complexity: detectDocumentChatComplexity(prompt, fileIds),
  }
  if (fileIds.length > 0) request.files = fileIds
  return request
}
