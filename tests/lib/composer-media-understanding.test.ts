import { describe, expect, it } from "vitest"

import { classifyIntentFastPath, shouldAutoActivateVideoGeneration } from "@/lib/ai-service"
import { detectComposerAutoMode } from "@/lib/chat/composer-auto-mode"
import {
  attachmentsBesideImagesAreMedia,
  classifyMediaFollowupPrompt,
  isAudioComposerFile,
  isMediaUnderstandingTurn,
  isVideoComposerFile,
  resolveMediaFollowupFiles,
} from "@/lib/chat/composer-files"

const VIDEO = { id: "vid-1", name: "clase-5h.mp4", mimeType: "video/mp4", type: "video/mp4" }
const AUDIO = { id: "aud-1", name: "reunion.m4a", mimeType: "audio/mp4", type: "audio/mp4" }
const IMAGE = { id: "img-1", name: "foto.png", mimeType: "image/png", type: "image/png" }
const PDF = { id: "doc-1", name: "brief.pdf", mimeType: "application/pdf", type: "application/pdf" }

// media_task: the send handler's media-understanding route (handleAgentTask
// before classifyIntent). agent_task: any later agent-task route.
type Route = "media_task" | "agent_task" | "video" | "voice" | "toast" | "other"

/**
 * Mirrors the composer's decisions for one draft (components/chat-interface-
 * enhanced.tsx): the typing effects (video auto-activation, Voz auto mode),
 * then the send handler (media turn → handleAgentTask before classifyIntent;
 * the image/video intent toast hands recordings to the agent task).
 */
function route(prompt: string, files: unknown[], history: unknown[] = []): Route {
  const followup = files.length === 0 ? resolveMediaFollowupFiles(prompt, history) : []
  const mediaTurn = followup.length > 0 || isMediaUnderstandingTurn(prompt, files)
  const composerHasMedia = files.some((file) => isAudioComposerFile(file) || isVideoComposerFile(file))
  // Typing: neither the video chip nor the auto mode (Voz) may switch on.
  if (shouldAutoActivateVideoGeneration(prompt) && !composerHasMedia && !mediaTurn) return "video"
  const auto = mediaTurn ? null : detectComposerAutoMode(prompt, { attachments: files as never })
  if (auto?.mode === "voice") return "voice"
  // Send.
  if (mediaTurn) return "media_task"
  const intent = classifyIntentFastPath(prompt)
  if (intent === "agent_task") return "agent_task"
  if (intent === "video" || intent === "image") {
    const sendFiles = files.length ? files : followup
    const hasNonImage = sendFiles.some((file) => !String((file as { type?: string }).type || "").startsWith("image/"))
    if (hasNonImage) return attachmentsBesideImagesAreMedia(sendFiles) ? "agent_task" : "toast"
    return intent === "video" ? "video" : "other"
  }
  return "other"
}

const MEDIA_UNDERSTANDING_PHRASES = [
  "quiero la transcripción de este video",
  "transcribe y resume",
  "hazme subtítulos srt",
  "dame la transcripción del audio",
  "qué dice este audio",
  "resume la clase",
  "del minuto 30 al 45",
  "transcríbeme este video de 5 horas",
  "sácame el acta de esta reunión",
  "transcribe",
  "transcribe el video y hazme un resumen",
  "transcribe este video y genera un resumen con los puntos clave",
  "hazme subtítulos srt de este video",
  "haz subtítulos de este video",
  "convierte este audio a texto",
  "¿de qué trata este video?",
  "quiero un resumen del video con los capítulos",
  "dame la transcripción del audio en word",
  "transcribe del 1:30 al 10:00",
  "ponlo en word",
  "trascribe el audio con marcas de tiempo",
  "transcribe this video",
]

describe("isMediaUnderstandingTurn — phrasing × attachment", () => {
  for (const phrase of MEDIA_UNDERSTANDING_PHRASES) {
    it(`«${phrase}» is a media turn with a video or audio, never with only an image or nothing`, () => {
      expect(isMediaUnderstandingTurn(phrase, [VIDEO])).toBe(true)
      expect(isMediaUnderstandingTurn(phrase, [AUDIO])).toBe(true)
      expect(isMediaUnderstandingTurn(phrase, [IMAGE])).toBe(false)
      expect(isMediaUnderstandingTurn(phrase, [])).toBe(false)
    })

    it(`«${phrase}» + video/audio reaches the media agent task, never video, Voz or the toast`, () => {
      expect(route(phrase, [VIDEO])).toBe("media_task")
      expect(route(phrase, [AUDIO])).toBe("media_task")
      expect(route(phrase, [AUDIO, VIDEO])).toBe("media_task")
      expect(detectComposerAutoMode(phrase, { attachments: [VIDEO] })).toBeNull()
      expect(detectComposerAutoMode(phrase, { attachments: [AUDIO] })).toBeNull()
    })
  }

  it("covers the audited breakers that classify as video generation or Voz", () => {
    // The fast path still says «video» for these; the media turn wins first.
    for (const phrase of ["quiero la transcripción de este video", "hazme subtítulos srt de este video", "transcribe el video y hazme un resumen"]) {
      expect(classifyIntentFastPath(phrase)).toBe("video")
      expect(route(phrase, [VIDEO])).toBe("media_task")
    }
    // «dame … audio» used to flip Voz and read the prompt aloud.
    expect(detectComposerAutoMode("dame la transcripción del audio")?.mode).toBe("voice")
    expect(route("dame la transcripción del audio", [AUDIO])).toBe("media_task")
  })

  it("accepts files known only by extension (WhatsApp / octet-stream picks)", () => {
    expect(isMediaUnderstandingTurn("transcribe", [{ id: "x", name: "nota.opus", type: "" }])).toBe(true)
    expect(isMediaUnderstandingTurn("transcribe", [{ id: "x", name: "clase.mkv", type: "application/octet-stream" }])).toBe(true)
  })

  it("keeps a recording next to a document on the agent task", () => {
    expect(isMediaUnderstandingTurn("transcribe el video", [VIDEO, PDF])).toBe(true)
    expect(isMediaUnderstandingTurn("resume el pdf", [PDF])).toBe(false)
  })
})

describe("negative cases keep their generation route", () => {
  it("image → video generation from an image", () => {
    for (const phrase of ["anima esta foto", "haz un video con esta imagen", "quiero un video"]) {
      expect(isMediaUnderstandingTurn(phrase, [IMAGE])).toBe(false)
      expect(route(phrase, [IMAGE])).not.toBe("media_task")
    }
    expect(attachmentsBesideImagesAreMedia([IMAGE])).toBe(false)
    expect(shouldAutoActivateVideoGeneration("haz un video con esta imagen")).toBe(true)
    expect(detectComposerAutoMode("haz un video con esta imagen", { attachments: [IMAGE] })?.mode).toBe("video")
    expect(route("haz un video con esta imagen", [IMAGE])).toBe("video")
  })

  it("video generation with no media", () => {
    expect(isMediaUnderstandingTurn("genera un video de un gato", [])).toBe(false)
    expect(detectComposerAutoMode("genera un video de un gato")?.mode).toBe("video")
    expect(route("genera un video de un gato", [])).toBe("video")
  })

  it("TTS with no media", () => {
    for (const phrase of ["lee este texto en voz alta", "narra este texto: Había una vez un reino lejano."]) {
      expect(isMediaUnderstandingTurn(phrase, [])).toBe(false)
      expect(resolveMediaFollowupFiles(phrase, [])).toEqual([])
      expect(route(phrase, [])).not.toBe("media_task")
    }
    expect(detectComposerAutoMode("narra este texto: Había una vez un reino lejano.")?.mode).toBe("voice")
    expect(route("narra este texto: Había una vez un reino lejano.", [])).toBe("voice")
  })

  it("a video-sounding prompt next to a recording goes to the agent task instead of the toast", () => {
    expect(isMediaUnderstandingTurn("haz un video más corto con este clip", [VIDEO])).toBe(false)
    expect(classifyIntentFastPath("haz un video más corto con este clip")).toBe("video")
    expect(attachmentsBesideImagesAreMedia([AUDIO])).toBe(true)
    expect(attachmentsBesideImagesAreMedia([IMAGE, VIDEO])).toBe(true)
    expect(route("haz un video más corto con este clip", [VIDEO])).toBe("agent_task")
    expect(route("haz un video más corto con este clip", [IMAGE, VIDEO])).toBe("agent_task")
    // A document is not a recording: that send keeps the image-only toast.
    expect(attachmentsBesideImagesAreMedia([PDF])).toBe(false)
    expect(attachmentsBesideImagesAreMedia([AUDIO, PDF])).toBe(false)
  })

  it("never switches Voz or Video on for an attached recording", () => {
    expect(detectComposerAutoMode("dame el audio de este video", { attachments: [VIDEO] })).toBeNull()
    expect(detectComposerAutoMode("haz un video de 10 segundos con este audio", { attachments: [AUDIO] })).toBeNull()
  })
})

describe("follow-ups reuse this chat's latest media batch", () => {
  const batch = [{ ...VIDEO }]
  const mediaTurn = [
    { role: "USER", content: "transcribe", files: JSON.stringify(batch) },
    { role: "ASSISTANT", content: "Transcripción de «clase-5h.mp4» …" },
  ]
  const later = (n: number) => Array.from({ length: n }, (_, index) => [
    { role: "USER", content: `pregunta ${index}`, files: [] },
    { role: "ASSISTANT", content: `respuesta ${index}` },
  ]).flat()

  it("resolves the follow-ups the composer used to send to /api/ai/generate", () => {
    for (const phrase of [
      "ponlo en word",
      "resume la clase",
      "qué dijo sobre la mitocondria",
      "¿y qué dijo el profesor sobre la fotosíntesis?",
      "del minuto 30 al 45",
      "dame la transcripción del audio",
      "hazme subtítulos srt",
      "sácame el acta de esta reunión",
      "hazme el acta",
      "y qué más dijo?",
      "¿qué se dice en el minuto 5?",
      "pásalo a word",
      "transcribe y resume",
      "resúmelo",
      "transcribe",
      "quiero la transcripción de los videos",
    ]) {
      expect(resolveMediaFollowupFiles(phrase, mediaTurn), phrase).toEqual(batch)
      expect(route(phrase, [], mediaTurn), phrase).toBe("media_task")
    }
  })

  it("«ponlo en word» only right after the media turn; content questions a few turns later", () => {
    expect(classifyMediaFollowupPrompt("ponlo en word")).toBe("immediate")
    expect(resolveMediaFollowupFiles("ponlo en word", [...mediaTurn, ...later(1)])).toEqual([])
    expect(classifyMediaFollowupPrompt("resume la clase")).toBe("contextual")
    expect(resolveMediaFollowupFiles("resume la clase", [...mediaTurn, ...later(3)])).toEqual(batch)
    expect(resolveMediaFollowupFiles("resume la clase", [...mediaTurn, ...later(5)])).toEqual([])
    expect(classifyMediaFollowupPrompt("transcribe los audios")).toBe("explicit")
    expect(resolveMediaFollowupFiles("transcribe los videos", [...mediaTurn, ...later(12)])).toEqual(batch)
  })

  it("never borrows media for documents, links or unrelated requests", () => {
    const docTurn = [...mediaTurn, { role: "USER", content: "revisa esto", files: [PDF] }, { role: "ASSISTANT", content: "ok" }]
    expect(resolveMediaFollowupFiles("ponlo en word", docTurn)).toEqual([])
    expect(resolveMediaFollowupFiles("resume la clase", docTurn)).toEqual([])
    for (const phrase of [
      "crea una clase en python",
      "explica la clase de python que hicimos",
      "¿qué dice la constitución sobre la libertad?",
      "resume este video https://youtu.be/abc123",
      "transcribe el video de youtube de la clase",
      "dame la transcripción del documento",
      "genera subtítulos para mi app",
      "genera un video de un gato",
      "haz un video de 1 minuto",
      "analiza las ventas de hoy",
      "resume el texto que te pegué sobre economía",
      "crea una web para analizar audios",
    ]) {
      expect(resolveMediaFollowupFiles(phrase, mediaTurn), phrase).toEqual([])
      expect(route(phrase, [], mediaTurn), phrase).not.toBe("media_task")
    }
  })

  it("never borrows the recording for general questions, schedules or another source", () => {
    // Within the contextual window, so only the prompt decides.
    const history = [...mediaTurn, ...later(1)]
    for (const phrase of [
      // Another speaker after the verb.
      "¿Qué dijo Einstein sobre la relatividad?",
      "qué propuso Keynes",
      "¿Quién dijo 'pienso luego existo'?",
      "¿Qué dijo Jesús en el sermón del monte?",
      "¿qué dijo el papa sobre la paz?",
      "what did the president say about taxes",
      // First-person present once the accent is dropped.
      "¿Cómo le explico a mi hijo la fotosíntesis?",
      "¿cómo hablo en público sin nervios?",
      "¿de qué hablo en mi discurso?",
      // A clock range is a schedule.
      "agenda una reunión mañana de 10:00 a 11:00",
      "hazme un horario de estudio de 8:00 a 12:00",
      "mi turno es de 9:00 a 17:00, ¿cuántas horas trabajo?",
      // A social class, or another object named first.
      "resume este artículo sobre la clase media",
      "resume la clase media en el Perú",
      "¿Qué dijo Marx sobre la clase obrera?",
      // The user's own text, pasted after a colon or quoted: a recording word
      // or a range in it is the material, not a pointer at the recording.
      "traduce al inglés: mañana no habrá clase",
      "traduce: nos vemos en la clase",
      "traduce este mensaje para mi profesora: no podré ir",
      "traduce \"hola profe\" al inglés",
      "traduce «hola profe» al inglés",
      "resume este texto: en la reunión de ayer acordamos subir precios",
      "resume este texto: el video de ayer se cortó",
      "traduce al inglés: me gustó el audio que mandaste",
      "traduce al inglés:\nen el minuto 90 metió gol",
      "¿Quién dijo \"nos vemos en clase\"?",
      // A clock range over the user's own day, not the recording.
      "resume mi día de 9:00 a 17:00",
      "resume mi agenda de 9:00 a 17:00",
      // A quote or a named speaker/event after the verb.
      "¿Quién dijo que la tierra era redonda?",
      "quien dijo que pienso luego existo",
      "¿Quién dijo que Dios había muerto?",
      "¿Quién dijo ‘pienso luego existo’?",
      "¿Qué se acordó en el Tratado de Versalles?",
      "¿Qué se decidió en la cumbre de Yalta?",
      "¿qué dijo a su esposa Napoleón antes de morir?",
      "¿qué dijo sobre la inflación el presidente del BCR?",
    ]) {
      expect(classifyMediaFollowupPrompt(phrase), phrase).toBeNull()
      expect(resolveMediaFollowupFiles(phrase, history), phrase).toEqual([])
      expect(route(phrase, [], history), phrase).not.toBe("media_task")
    }
  })

  it("keeps questions about what the recording said, with or without the speaker named", () => {
    const history = [...mediaTurn, ...later(1)]
    for (const phrase of [
      "¿cuándo habló de la mitocondria?",
      "¿de qué habló?",
      "¿qué explicó la profesora sobre las células?",
      "¿qué explico el profesor sobre las células?",
      "¿qué fue lo que dijo al final?",
      "¿qué le dijo a los alumnos?",
      "¿qué dijo él sobre el examen?",
      "¿quién dijo eso?",
      "¿qué acordaron?",
      "¿qué se habló en la reunión?",
      "what did he say about the exam",
      "resume la clase en un documento",
      "del 1:30 al 10:00",
      "y del 12:00 al 15:30?",
      "transcribe del 1:30 al 10:00",
      // The material after the colon is only the range.
      "transcribe: del 1:30 al 10:00",
      "resume la clase: del minuto 30 al 45",
      "¿quién habló?",
      // A capital that opens a sentence, an all-caps prompt or a recording
      // word next to the name is still about the recording.
      "¿Qué dijo sobre la mitocondria? Explícalo simple",
      "QUE DIJO SOBRE LA MITOCONDRIA",
      "¿qué explicó el Profe sobre Newton?",
    ]) {
      expect(classifyMediaFollowupPrompt(phrase), phrase).toBe("contextual")
      expect(resolveMediaFollowupFiles(phrase, history), phrase).toEqual(batch)
    }
    // Without the accent «hablo» is first person: no recording, no media turn.
    expect(classifyMediaFollowupPrompt("¿cuándo hablo de la mitocondria?")).toBeNull()
  })
})
