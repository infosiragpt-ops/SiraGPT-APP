export type DictationMode = "idle" | "native" | "recorder"

type SpeechWindow = {
  SpeechRecognition?: new () => unknown
  webkitSpeechRecognition?: new () => unknown
}

export function getSpeechRecognitionCtor(
  win?: SpeechWindow | null,
): (new () => unknown) | null {
  if (!win) return null
  return win.SpeechRecognition || win.webkitSpeechRecognition || null
}

export function resolveDictationLanguage(input: {
  languages?: readonly string[]
  language?: string
  documentLang?: string
} = {}): string {
  const preferred =
    input.languages?.find((lang) => lang.toLowerCase().startsWith("es"))
    || input.language
    || input.documentLang
    || "es-ES"
  return preferred.toLowerCase().startsWith("en") ? "es-ES" : preferred
}

export function shouldRestartNativeDictation(
  mode: DictationMode,
  userWantsListening: boolean,
): boolean {
  return userWantsListening && mode === "native"
}

export function isSpeechPermissionError(error: string): boolean {
  return error === "not-allowed" || error === "service-not-allowed"
}

export function isIgnorableSpeechError(error: string): boolean {
  return error === "no-speech" || error === "aborted"
}
