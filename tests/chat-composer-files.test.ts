import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildAgentFileMetadata,
  collectMessageFileIds,
  collectProcessingFileIds,
  collectUploadFileIds,
  describeMediaTranscriptionProgress,
  isAudioComposerFile,
  isVideoComposerFile,
  isComposerFileProcessingPending,
  isComposerFileUploadFailed,
  isComposerFileSendBlockedByFailure,
  isComposerFileUploadPending,
  parseMessageFiles,
  isMediaFollowupPrompt,
  isPendingDeliveryAmendPrompt,
  mayReachMediaBatch,
  resolveMediaFollowupFiles,
  shouldWaitForDocumentProcessing,
} from "../lib/chat/composer-files"

describe("chat composer files", () => {
  it("normalizes uploaded file ids and excludes empty optimistic records", () => {
    assert.deepEqual(collectUploadFileIds([
      " direct-id ",
      { id: "server-id" },
      { fileId: "file-id" },
      { attachmentId: "attachment-id" },
      { id: "" },
    ]), ["direct-id", "server-id", "file-id", "attachment-id"])
  })

  it("extracts file ids from persisted JSON strings and fileId aliases", () => {
    assert.deepEqual(parseMessageFiles('[{"fileId":"persisted-1"},{"id":"persisted-1"},{"attachmentId":"persisted-2"}]'), [
      { fileId: "persisted-1" },
      { id: "persisted-1" },
      { attachmentId: "persisted-2" },
    ])
    assert.deepEqual(
      collectMessageFileIds('[{"fileId":"persisted-1"},{"id":"persisted-1"},{"attachmentId":"persisted-2"}]'),
      ["persisted-1", "persisted-2"],
    )
    assert.deepEqual(collectMessageFileIds([{ id: "live-id" }, { fileId: "alias-id" }]), ["live-id", "alias-id"])
  })

  it("distinguishes transport uploads from document processing", () => {
    assert.equal(isComposerFileUploadPending({ status: "uploading" }), true)
    assert.equal(isComposerFileUploadPending({ id: "1", status: "uploading" }), false)
    assert.equal(shouldWaitForDocumentProcessing({ id: "1", name: "brief.pdf" }), true)
    assert.equal(shouldWaitForDocumentProcessing({ id: "1", name: "photo.png" }), false)
    assert.equal(isComposerFileProcessingPending({ id: "1", name: "brief.pdf", processingStage: "extracting" }), true)
    assert.equal(isComposerFileProcessingPending({ id: "1", name: "brief.pdf", processingStage: "ready" }), false)
    assert.equal(isComposerFileUploadFailed({ id: "1", stage: "failed" }), true)
  })

  it("builds agent metadata without embedding the full long-paste text", () => {
    const metadata = buildAgentFileMetadata([{
      id: "paste-1",
      name: "paste.txt",
      type: "text/plain",
      __siraLongPaste: {
        kind: "long_paste_document",
        title: "Informe pegado",
        filename: "informe.txt",
        text: "contenido privado completo",
        preview: "contenido privado…",
        originalCharCount: 26,
        originalWordCount: 3,
        originalLineCount: 1,
        createdAt: "2026-08-05T00:00:00.000Z",
      },
    }])

    assert.equal(metadata.length, 1)
    assert.equal(metadata[0].name, "Informe pegado")
    assert.equal(metadata[0].isLongPasteDocument, true)
    assert.equal("text" in (metadata[0].longPasteMeta || {}), false)
    assert.equal(metadata[0].longPasteMeta?.preview, "contenido privado…")
  })
})

describe("historical media batch follow-ups", () => {
  const files = Array.from({ length: 50 }, (_, index) => ({ id: `audio-${index}`, name: `${index}.mp3`, mimeType: "audio/mpeg" }))
  const history = [
    { role: "USER", files: JSON.stringify(files) },
    { role: "ASSISTANT", files: [{ id: "report", name: "report.pdf" }] },
    { role: "USER", content: "analiza los 50 audios", files: [] },
    { role: "ASSISTANT", content: "Análisis parcial" },
  ]

  it("restores all 50 IDs after refresh and skips empty follow-ups for repeated retries", () => {
    assert.deepEqual(resolveMediaFollowupFiles("reintenta los audios fallidos", history), files)
    assert.deepEqual(resolveMediaFollowupFiles("analiza los50", history), files)
    assert.deepEqual(resolveMediaFollowupFiles("transcribe todos", history), files)
    assert.deepEqual(resolveMediaFollowupFiles("reintenta los fallidos", [
      ...history, { role: "USER", content: "reintenta los audios fallidos" },
    ]), files)
  })

  it("a batch of 100 recordings (the composer cap) is one follow-up target; 101 is not", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => ({ id: `rec-${index}`, name: `${index}.mp4`, mimeType: "video/mp4" }))
    assert.deepEqual(resolveMediaFollowupFiles("transcribe todos", [{ role: "USER", files: JSON.stringify(hundred) }]), hundred)
    const tooMany = [...hundred, { id: "rec-100", name: "100.mp4", mimeType: "video/mp4" }]
    assert.deepEqual(resolveMediaFollowupFiles("transcribe todos", [{ role: "USER", files: JSON.stringify(tooMany) }]), [])
  })

  it("while a batch transcribes in the background, short instructions about its result reach it", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }, { id: "v2", name: "taller.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Recibí 2 archivos…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1", "v2"], stoppedReason: "media_delivery_handoff" } }
    const pendingChat = [{ role: "USER", content: "transcribir", files: JSON.stringify(batch) }, handoff]
    for (const prompt of ["en Word", "y en pdf", "mejor con subtítulos", "está en inglés", "el audio está en portugués",
      "los nombres son Huamán y Quispe", "son 3 hablantes", "ya no la traduzcas", "sin resumen", "¿de qué hablan?",
      "¿de qué trata?", "dime los temas", "hazme 5 preguntas", "dime de qué trata", "dame las ideas principales", "sácame las conclusiones",
      "¿de qué se habla?", "¿quién habla más?", "¿de qué hablan? 🤔", "¿qué dice acerca del trabajo final?"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
    // Nothing pending: the same words are a new request.
    assert.deepEqual(resolveMediaFollowupFiles("en Word", [pendingChat[0]]), [])
    // Settled by its delivery: not pending any more.
    const delivered = [...pendingChat, { role: "ASSISTANT", content: "Listo", metadata: { source: "media-delivery", mediaDelivery: "md_1", transcriptionFileIds: ["v1", "v2"] } }]
    assert.deepEqual(resolveMediaFollowupFiles("en Word", delivered), [])
    // A bare ask reaches it only right after the hand-off; after another turn it is the chat's.
    assert.deepEqual(resolveMediaFollowupFiles("hazme 5 preguntas", [...pendingChat, { role: "USER", content: "¿qué es una célula?" }, { role: "ASSISTANT", content: "…" }]), [])
    // Ambiguous or unrelated words stay unrouted.
    for (const prompt of ["en inglés", "hola", "¿qué hora es?", "en word el informe del documento"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), [], prompt)
    }
    // A later chat never hides the pending batch from a follow-up about it.
    const chatty = [...pendingChat, ...Array.from({ length: 6 }, (_, i) => ({ role: "USER", content: `otra cosa ${i}` }))]
    assert.deepEqual(resolveMediaFollowupFiles("resume la clase", chatty), batch)
    assert.deepEqual(resolveMediaFollowupFiles("resume la clase", [pendingChat[0], ...chatty.slice(2)]), [], "not pending: the usual reach")
    // A fact about the recording reaches it too; a wish about the result does not.
    for (const prompt of ["está en inglés", "los nombres son Huamán y Quispe", "son 3 hablantes"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, chatty), batch, prompt)
    }
  })

  it("while a batch transcribes, a refusal about its result reaches it", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Te aviso aquí cuando termine…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1"], stoppedReason: "media_delivery_handoff" } }
    const pendingChat = [{ role: "USER", content: "transcribe este video", files: JSON.stringify(batch) }, handoff]
    for (const prompt of ["sin subtítulos", "no quiero subtítulos", "no necesito el Word", "quita los subtítulos", "nada de PDF", "no lo conviertas a Word", "no me des el PDF",
      "sin Word ni PDF", "no quiero que lo resumas", "no hace falta resumir", "Word no, PDF sí", "sin subtítulos por favor"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
    // «documento» is the deliverable document: its refusal reaches the batch too.
    for (const prompt of ["no quiero el documento", "sin documento", "documento no", "ya no lo quiero en documento"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
    // Nothing pending: the same words are not about a recording.
    assert.deepEqual(resolveMediaFollowupFiles("no quiero subtítulos", [pendingChat[0], { role: "ASSISTANT", content: "Listo",
      metadata: { source: "media-delivery", mediaDelivery: "md_1", transcriptionFileIds: ["v1"] } }]), [])
    // Another source stays another source.
    assert.deepEqual(resolveMediaFollowupFiles("la transcripción del pdf", pendingChat), [])
  })

  it("while a batch transcribes, a conversion or a refusal after the format reaches it; another PDF stays another source", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Te aviso aquí cuando termine…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1"], stoppedReason: "media_delivery_handoff" } }
    const pendingChat = [{ role: "USER", content: "transcribe este video en PDF", files: JSON.stringify(batch) }, handoff]
    for (const prompt of ["pásalo de PDF a Word", "conviértelo de PDF a Word", "cámbialo de PDF a Word", "cambia el PDF por un documento Word",
      "el Word sí, el PDF no", "solo en Word, el PDF no lo necesito", "también me lo pasas en PDF", "el PDF también lo quiero"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
    for (const prompt of ["resume el PDF de la clase", "pásame el resumen del PDF a Word", "dame el informe del PDF"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), [], prompt)
    }
  })

  it("a conversion with another source stays in the chat; two choices need their comma or «y»", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Te aviso aquí cuando termine…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1"], stoppedReason: "media_delivery_handoff" } }
    const pendingChat = [{ role: "USER", content: "tesis", files: JSON.stringify([{ id: "p1", name: "tesis.pdf", mimeType: "application/pdf" }]) },
      { role: "ASSISTANT", content: "Listo." }, { role: "USER", content: "transcribe este video en PDF", files: JSON.stringify(batch) }, handoff]
    for (const prompt of ["pásame de PDF a Word el documento de mi tesis", "convierte de PDF a Word las páginas del libro", "el pdf no el word sí", "PDF no tiene portada"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), [], prompt)
    }
    for (const prompt of ["pásalo de PDF a Word", "el Word sí, el PDF no", "Word no y PDF sí", "pdf no"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
  })

  it("only the closing forms of «el PDF no / también» reach a pending batch; a remark about the PDF, or the user's own PDF, stays in the chat", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Te aviso aquí cuando termine…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1"], stoppedReason: "media_delivery_handoff" } }
    const pendingChat = [{ role: "USER", content: "apuntes", files: JSON.stringify([{ id: "p1", name: "apuntes-escaneados.pdf", mimeType: "application/pdf" }]) },
      { role: "ASSISTANT", content: "Listo." },
      { role: "USER", content: "transcribe este video en Word y PDF", files: JSON.stringify(batch) }, handoff]
    for (const prompt of ["el PDF no", "el PDF no me sirve", "el PDF también mándamelo", "el PDF también dámelo", "Word sí"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
    for (const prompt of ["el PDF no se ve bien", "el PDF no tiene que tener portada", "el PDF no lo quiero con marcas de tiempo",
      "el documento no tiene que ser muy largo", "el PDF también tiene errores",
      "dame la transcripción de mi PDF en Word", "quiero la transcripción de este PDF en Word"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), [], prompt)
    }
  })

  it("a fact with words after it, a question about a moment, and a courtesy in between still reach the batch", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Te aviso aquí cuando termine…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1"], stoppedReason: "media_delivery_handoff" } }
    const pendingChat = [{ role: "USER", content: "transcribe este video", files: JSON.stringify(batch) }, handoff]
    const later = [...pendingChat, ...Array.from({ length: 12 }, (_, i) => ({ role: "USER", content: `otra cosa ${i}` }))]
    for (const prompt of ["los audios están en inglés, gracias", "está en inglés 🙏", "esta en ingles porfa", "son 2 hablantes: Juan y María",
      "el audio está en inglés y son tres hablantes", "está en inglés, tradúcelo al español", "los nombres son Huamán y Quispe"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, later), batch, prompt)
    }
    for (const prompt of ["¿qué dice sobre el examen?", "¿y qué dice al final?", "¿qué más dice?", "¿qué es lo que dice?",
      "¿quién habla primero?", "¿dónde lo dice?", "¿cuándo habla de la guerra?", "¿qué explica de la mitosis?"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
    // A courtesy or a status ping in between is no answer to be about.
    const acked = [...pendingChat, { role: "USER", content: "ok gracias" }, { role: "ASSISTANT", content: "¡De nada!" },
      { role: "USER", content: "¿cuánto falta?" }, { role: "ASSISTANT", content: "Sigue transcribiendo." }]
    for (const prompt of ["mejor sin resumen", "tradúcelo al inglés", "con subtítulos", "en pdf"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, acked), batch, prompt)
    }
    // A question or a lowercase opinion is never a fact about the recording.
    for (const prompt of ["los términos son confusos, ¿me los explicas?", "¿los nombres son importantes en una marca?", "los términos son confusos"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, later), [], prompt)
    }
  })

  it("while a batch transcribes, the chat's own questions and requests stay with the chat", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Te aviso aquí cuando termine…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1"], stoppedReason: "media_delivery_handoff" } }
    const pendingChat = [{ role: "USER", content: "transcribe este video", files: JSON.stringify(batch) }, handoff]
    // Questions about anything else, asked right after the hand-off.
    for (const prompt of ["¿Cómo se explica la fotosíntesis?", "¿Qué dice la ley sobre el despido injustificado?",
      "¿Dónde se habla quechua?", "hay 3 personas en mi equipo, ¿cómo divido las tareas?", "¿es en inglés el examen de mañana?"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), [], prompt)
    }
    // «tradúcelo», «resúmelo», «ponlo en Word» about an answer written after the hand-off.
    const emailed = [...pendingChat, { role: "USER", content: "escríbeme un correo para mi jefe" }, { role: "ASSISTANT", content: "Estimado jefe…" }]
    for (const prompt of ["tradúcelo al inglés", "resúmelo", "ponlo en word", "pásalo a PDF", "en word", "sin resumen", "¿de qué hablan?"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, emailed), [], prompt)
    }
    // Right after the hand-off they are about the batch.
    for (const prompt of ["tradúcelo al inglés", "en word", "¿de qué hablan?", "¿qué dijo?"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
    // An amendment's message carries the batch: the next one chains on it.
    const amended = [...pendingChat, { role: "USER", content: "está en inglés", files: JSON.stringify(batch) }, { role: "ASSISTANT", content: "Anotado…", metadata: { mediaDeliveryAmended: "md_1" } }]
    assert.deepEqual(resolveMediaFollowupFiles("en Word", amended), batch)
  })

  it("after «Detener», the resume the stop line invites reaches the recordings; elsewhere it stays with the chat", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }, { id: "v2", name: "taller.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Recibí 2 archivos…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1", "v2"], stoppedReason: "media_delivery_handoff" } }
    const stopLine = { role: "ASSISTANT", content: "Detuve la transcripción de 2 archivos (clase.mp4 y taller.mp4). Si la necesitas, pídemela de nuevo y retomo donde quedó.",
      metadata: JSON.stringify({ source: "media-delivery", mediaDelivery: "md_1", transcriptionFileIds: ["v1", "v2"], deliveryKind: "cancelled", stoppedReason: "media_delivery_cancelled" }) }
    const stopped = [{ role: "USER", content: "transcribir", files: JSON.stringify(batch) }, handoff, stopLine]
    for (const prompt of ["retómala", "sí, retómala", "Sí, retómala, por favor", "reanúdala", "continúala", "retoma la transcripción",
      "reanuda la transcripción", "continúa con la transcripción", "sigue con la transcripción", "sigue transcribiendo las clases",
      "retoma los audios", "ok, reanuda las grabaciones", "¿puedes retomar la transcripción?", "¿puedes retomarla?",
      "por favor continúa con la transcripción", "quiero que sigas transcribiendo"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, stopped), batch, prompt)
    }
    // A few turns later the explicit forms still reach it.
    const later = [...stopped, { role: "USER", content: "¿qué es la fotosíntesis?" }, { role: "ASSISTANT", content: "…" }]
    assert.deepEqual(resolveMediaFollowupFiles("retoma la transcripción", later), batch)
    // Bare «continúa» / «sigue» continue the chat; so does any resume without a stop.
    for (const prompt of ["continúa", "sigue", "continúa por favor", "sigue con la receta"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, stopped), [], prompt)
    }
    const delivered = [stopped[0], { role: "ASSISTANT", content: "Listo", metadata: { source: "media-delivery", mediaDelivery: "md_1", transcriptionFileIds: ["v1", "v2"] } }]
    for (const prompt of ["continúalo", "retómala", "sigue con la transcripción del documento"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, delivered), [], prompt)
    }
    // A stop that came before the latest recordings belongs to another batch.
    const newer = [...stopped, { role: "USER", content: "y este", files: JSON.stringify([{ id: "v3", name: "otro.mp4", mimeType: "video/mp4" }]) },
      { role: "ASSISTANT", content: "Listo", metadata: { source: "media-delivery", mediaDelivery: "md_2", transcriptionFileIds: ["v3"] } }]
    assert.deepEqual(resolveMediaFollowupFiles("retómala", newer), [])
  })

  it("after «Detener», a pronoun or a class word answers the stop line only right after it", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }, { id: "v2", name: "taller.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Recibí 2 archivos…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1", "v2"], stoppedReason: "media_delivery_handoff" } }
    const stopLine = { role: "ASSISTANT", content: "Detuve la transcripción de 2 archivos (clase.mp4 y taller.mp4). Si la necesitas, pídemela de nuevo y retomo donde quedó.",
      metadata: JSON.stringify({ source: "media-delivery", mediaDelivery: "md_1", transcriptionFileIds: ["v1", "v2"], deliveryKind: "cancelled", stoppedReason: "media_delivery_cancelled" }) }
    const stopped = [{ role: "USER", content: "transcribir", files: JSON.stringify(batch) }, handoff, stopLine]
    // Another request in between: «continúalo» continues that answer, never the recordings.
    const essay = [...stopped, { role: "USER", content: "escríbeme un ensayo sobre la revolución francesa" }, { role: "ASSISTANT", content: "La Revolución…" }]
    for (const prompt of ["continúalo", "retómala", "continúa la clase", "sigue profe", "continúa con la sesión", "continúa con la entrevista que me preparabas"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, essay), [], prompt)
    }
    // Right after the stop line they answer it; a courtesy in between is no other request.
    for (const prompt of ["continúa la clase", "retómala", "continúalo", "sigue con la sesión", "retoma todas las clases"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, stopped), batch, prompt)
    }
    // The recording must be what is resumed, not a word anywhere in the message.
    for (const prompt of ["sigue explicando la clase", "continúa con la explicación de la clase", "sigue con el tema de la clase", "sigue profe",
      "sigue explicando el audio"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, stopped), [], prompt)
    }
    const thanked = [...stopped, { role: "USER", content: "ok gracias" }, { role: "ASSISTANT", content: "De nada" }]
    assert.deepEqual(resolveMediaFollowupFiles("retómala", thanked), batch)
    // Naming the transcript reaches them a few turns later, never forever.
    const far = [...stopped, ...[1, 2, 3, 4, 5].flatMap((n) => [{ role: "USER", content: `pregunta ${n} sobre biología` }, { role: "ASSISTANT", content: "…" }])]
    assert.deepEqual(resolveMediaFollowupFiles("retoma la transcripción", far), [])
    // A follow-up routed to the recordings carries them: the stop line stays in reach.
    const summarised = [...stopped, { role: "USER", content: "resume la clase que ya está lista", files: JSON.stringify(batch) }, { role: "ASSISTANT", content: "Resumen…" }]
    for (const prompt of ["retoma la transcripción", "ok, retómala", "¿puedes retomar la transcripción?", "sigue transcribiendo las clases"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, summarised), batch, prompt)
    }
    // «continúalo» there may be the summary just given.
    assert.deepEqual(resolveMediaFollowupFiles("continúalo", summarised), [])
    // «retoma las demás» after a summary of the ready ones is the stopped ones; after an essay it is not.
    for (const prompt of ["retoma las demás", "sigue con el resto", "continúa con las que faltan"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, summarised), batch, prompt)
      assert.deepEqual(resolveMediaFollowupFiles(prompt, essay), [], prompt)
    }
    // Other recordings sent since: that stop line is no longer the one answered.
    const other = [...stopped, { role: "USER", content: "y este", files: JSON.stringify([{ id: "v3", name: "otro.mp4", mimeType: "video/mp4" }]) }]
    assert.deepEqual(resolveMediaFollowupFiles("retoma la transcripción", other), [])
    // Even when the message that brought them only said thanks.
    const thanksWithFiles = [...stopped, { role: "USER", content: "ok gracias", files: JSON.stringify([{ id: "v3", name: "otro.mp4", mimeType: "video/mp4" }]) }]
    assert.deepEqual(resolveMediaFollowupFiles("retómala", thanksWithFiles), [])
  })

  it("a fact after a lead-in or a colon reaches a pending batch; one about two languages stays in the chat", () => {
    const batch = [{ id: "v1", name: "clase.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Te aviso aquí cuando termine…", metadata: { mediaDeliveryHandoff: "md_1", transcriptionFileIds: ["v1"], stoppedReason: "media_delivery_handoff" } }
    const pendingChat = [{ role: "USER", content: "transcribe", files: JSON.stringify(batch) }, handoff]
    for (const prompt of ["Por cierto, está en inglés", "Ah, el audio está en inglés", "Ojo, son 3 hablantes", "Ojo: son 3 hablantes",
      "Los nombres son: Juan Pérez y María López", "los apellidos son: Huamán, Quispe", "Ojo, los nombres son Huamán y Quispe",
      "Los nombres son – Huamán y Quispe"]) {
      assert.equal(isPendingDeliveryAmendPrompt(prompt), true, prompt)
      assert.deepEqual(resolveMediaFollowupFiles(prompt, pendingChat), batch, prompt)
    }
    for (const prompt of ["el audio está en inglés y español", "habla en español y quechua", "los audios están en español y en inglés", "está en inglés e italiano"]) {
      assert.equal(isPendingDeliveryAmendPrompt(prompt), false, prompt)
    }
    // A second clause after «y» is still cut off: the fact stays a fact.
    assert.equal(isPendingDeliveryAmendPrompt("el audio está en inglés y son tres hablantes"), true)
    assert.equal(mayReachMediaBatch("retómala"), true)
    assert.equal(mayReachMediaBatch("en Word"), true)
    assert.equal(mayReachMediaBatch("escríbeme un poema"), false)
  })

  it("a resume reaches the recordings its stop line names, past other uploads, with fillers, and after a reply that asks for it", () => {
    const stopped = [{ id: "a1", name: "clase-larga.mp4", mimeType: "video/mp4" }]
    const handoff = { role: "ASSISTANT", content: "Te aviso aquí cuando termine.", metadata: { mediaDeliveryHandoff: "md_A", transcriptionFileIds: ["a1"], stoppedReason: "media_delivery_handoff" } }
    const stopLine = { role: "ASSISTANT", content: "Detuve la transcripción de «clase-larga.mp4».",
      metadata: JSON.stringify({ source: "media-delivery", mediaDelivery: "md_A", transcriptionFileIds: ["a1"], deliveryKind: "cancelled", stoppedReason: "media_delivery_cancelled" }) }
    // A voice note or a PDF sent while it transcribed, before the Stop.
    for (const between of [[{ id: "b1", name: "nota.ogg", mimeType: "audio/ogg" }], [{ id: "d1", name: "informe.pdf", mimeType: "application/pdf" }]]) {
      const chat = [{ role: "USER", content: "transcribe", files: JSON.stringify(stopped) }, handoff,
        { role: "USER", content: "y esto", files: JSON.stringify(between) }, { role: "ASSISTANT", content: "Listo." }, stopLine]
      for (const prompt of ["retoma la transcripción", "retómala"]) {
        assert.deepEqual(resolveMediaFollowupFiles(prompt, chat), stopped, `${prompt} (${between[0].name})`)
      }
    }
    const chat = [{ role: "USER", content: "transcribe", files: JSON.stringify(stopped) }, handoff, stopLine]
    for (const prompt of ["retoma por favor la transcripción", "retoma de nuevo la transcripción", "continúa por favor con la transcripción",
      "retoma también los audios", "Sí, por favor, retómala", "retoma la junta", "retoma la audiencia"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, chat), stopped, prompt)
    }
    // «el archivo» after a request about another file is that file.
    const spreadsheet = [...chat, { role: "USER", content: "hazme un Excel con mis gastos del mes" }, { role: "ASSISTANT", content: "Listo, aquí está gastos.xlsx." }]
    for (const prompt of ["sigue con el archivo y agrégale una columna de totales", "continúa con el archivo"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, spreadsheet), [], prompt)
    }
    assert.deepEqual(resolveMediaFollowupFiles("continúa con el archivo", chat), stopped, "right after the stop line it is the recording")
    // A reply that says «escribe «retómala»» (its stoppedFileIds) is a stop line too, also after another request.
    const batch = [{ id: "v0", name: "Clase 1.mp4", mimeType: "video/mp4" }, { id: "v2", name: "Clase 2.mp4", mimeType: "video/mp4" }]
    const answered = [{ role: "USER", content: "transcribe", files: JSON.stringify(batch) },
      { role: "ASSISTANT", content: "Tarea detenida.", metadata: { stoppedReason: "cancelled" } },
      { role: "USER", content: "escríbeme un correo para mi profesor" }, { role: "ASSISTANT", content: "Estimado profesor…" },
      { role: "USER", content: "¿de qué trata la clase 1?", files: JSON.stringify(batch) },
      { role: "ASSISTANT", content: "Una grabación sigue detenida: escribe «retómala» para seguir donde quedó.",
        metadata: { transcriptionFileIds: ["v0", "v2"], stoppedFileIds: ["v2"] } }]
    assert.deepEqual(resolveMediaFollowupFiles("retómala", answered), batch)
  })

  it("after an answer that only mentions the stopped recordings, «continúalo» continues the answer; «retómala» still resumes", () => {
    const batch = [{ id: "v0", name: "Clase 1.mp4", mimeType: "video/mp4" }, { id: "v2", name: "Clase 2.mp4", mimeType: "video/mp4" }]
    const answered = [{ role: "USER", content: "transcribe", files: JSON.stringify(batch) },
      { role: "ASSISTANT", content: "Tarea detenida.", metadata: { stoppedReason: "cancelled" } },
      { role: "USER", content: "¿de qué trata la clase 1?", files: JSON.stringify(batch) },
      { role: "ASSISTANT", content: "La clase 1 trata de: 1) la mitocondria… Una grabación sigue detenida: escribe «retómala» para seguir donde quedó.",
        metadata: { transcriptionFileIds: ["v0", "v2"], stoppedFileIds: ["v2"] } }]
    for (const prompt of ["continúalo", "sigue con los otros puntos", "continúa con los demás temas", "sigue con el resto de la explicación", "continúala", "sigue con la clase"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, answered), [], prompt)
    }
    for (const prompt of ["retómala", "sí, retómala", "retoma la transcripción",
      "retómalas todas", "retómala porfis", "retómala de nuevo", "retoma las demás", "retoma la clase 2"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, answered), batch, prompt)
    }
  })

  it("«el resto de las grabaciones», «las demás transcripciones» or «… que detuve» resume right after the stop line", () => {
    const stopped = [{ id: "a1", name: "Clase 1.mp4", mimeType: "video/mp4" }, { id: "a2", name: "Clase 2.mp4", mimeType: "video/mp4" }]
    const ids = ["a1", "a2"]
    const chat = [{ role: "USER", content: "transcribe", files: JSON.stringify(stopped) },
      { role: "ASSISTANT", content: "Te aviso aquí cuando termine.", metadata: { mediaDeliveryHandoff: "md_A", transcriptionFileIds: ids, stoppedReason: "media_delivery_handoff" } },
      { role: "ASSISTANT", content: "Detuve la transcripción de 2 grabaciones.",
        metadata: JSON.stringify({ source: "media-delivery", mediaDelivery: "md_A", transcriptionFileIds: ids, deliveryKind: "cancelled", stoppedReason: "media_delivery_cancelled" }) }]
    for (const prompt of ["sigue con el resto de las grabaciones", "continúa con el resto de los audios", "retoma las demás transcripciones",
      "retoma las otras dos que detuve", "retoma las demás ahora"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, chat), stopped, prompt)
    }
    for (const prompt of ["sigue con los otros puntos", "sigue con el resto de la explicación"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, chat), [], prompt)
    }
  })

  it("a follow-up that carries the whole batch between the stop line and «retómalas» keeps the resume reaching it", () => {
    const batch = [1, 2, 3].map(n => ({ id: `c${n}`, name: `Clase ${n}.mp4`, mimeType: "video/mp4" }))
    const files = JSON.stringify(batch)
    const ids = ["c1", "c2", "c3"]
    const chat = [
      { role: "USER", content: "transcribe estas 3 clases", files },
      { role: "ASSISTANT", content: "Te aviso aquí cuando termine.", metadata: { mediaDeliveryHandoff: "md_A", transcriptionFileIds: ids, stoppedReason: "media_delivery_handoff" } },
      { role: "ASSISTANT", content: "Detuve la transcripción de 3 grabaciones.",
        metadata: JSON.stringify({ source: "media-delivery", mediaDelivery: "md_A", transcriptionFileIds: ids, deliveryKind: "cancelled", stoppedReason: "media_delivery_cancelled" }) },
      { role: "USER", content: "transcribe la clase 3", files },
      { role: "ASSISTANT", content: "Te aviso aquí cuando termine.\n\n2 grabaciones siguen detenidas: escribe «retómalas» si las quieres.",
        metadata: { transcriptionFileIds: ids, mediaDeliveryHandoff: "md_B", stoppedFileIds: ["c1", "c2"] } },
      { role: "USER", content: "ponlo en Word", files },
      { role: "ASSISTANT", content: "Anotado: cuando termine la transcripción te la entrego en Word.",
        metadata: { transcriptionFileIds: ids, mediaDeliveryAmended: "md_B", mediaDeliveryChanges: ["document"] } },
    ]
    for (const prompt of ["retómalas", "retoma las demás", "sí, retómalas"]) {
      assert.deepEqual(resolveMediaFollowupFiles(prompt, chat), batch, prompt)
    }
  })

  it("stops at the newest attached nonmedia batch and never borrows another chat's files", () => {
    assert.deepEqual(resolveMediaFollowupFiles("analiza los audios", [
      ...history, { role: "USER", files: [{ id: "new-doc", name: "brief.pdf" }] },
    ]), [])
    assert.deepEqual(resolveMediaFollowupFiles("analiza los audios", []), [])
    assert.deepEqual(resolveMediaFollowupFiles("analiza el código", history), [])
    assert.deepEqual(resolveMediaFollowupFiles("crea una web", history), [])
    assert.deepEqual(resolveMediaFollowupFiles("crea una web para analizar audios", history), [])
    assert.equal(isMediaFollowupPrompt("analiza las ventas de hoy"), false)
  })
})

describe("collectProcessingFileIds", () => {
  const TXT = "text/plain"

  it("lists attachments that still need polling and skips settled or id-less ones", () => {
    const ids = collectProcessingFileIds([
      { id: "paste-1", name: "campo-contenido-2026-09-02T20-31-40.txt", mimeType: TXT, status: "processing", processingStage: "extracting" },
      { id: "doc-2", name: "informe.pdf", mimeType: "application/pdf", status: "processing", processingStage: "chunking" },
      { id: "ready-3", name: "notas.txt", mimeType: TXT, status: "ready", processingStage: "ready" },
      { id: "failed-4", name: "roto.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", status: "failed", processingStage: "failed" },
      { tempId: "tmp-5", name: "subiendo.txt", mimeType: TXT, status: "uploading" },
      { id: "img-6", name: "foto.png", mimeType: "image/png", status: "ready" },
    ])
    assert.deepEqual(ids, ["paste-1", "doc-2"])
  })

  it("keeps a chip flagged processing without any stage (upload response arrived before the pipeline reported)", () => {
    assert.deepEqual(
      collectProcessingFileIds([{ id: "paste-7", name: "campo-contenido.txt", mimeType: TXT, status: "processing" }]),
      ["paste-7"],
    )
    assert.deepEqual(collectProcessingFileIds([{ id: "x", name: "campo-contenido.txt", mimeType: TXT, status: "processing", processingStage: "ready" }]), [])
    assert.deepEqual(collectProcessingFileIds([]), [])
    assert.deepEqual(collectProcessingFileIds([null, undefined, "junk"] as any), [])
  })
})

 describe("media batch send admission", () => {
  it("permits partial media processing failures but not lost uploads or failed documents", () => {
    assert.equal(isComposerFileSendBlockedByFailure({ id: "audio-1", name: "one.mp3", processingStage: "failed" }), false)
    assert.equal(isComposerFileSendBlockedByFailure({ id: "video-1", name: "two.mp4", processingStage: "failed" }), false)
    assert.equal(isComposerFileSendBlockedByFailure({ tempId: "no-upload", name: "one.mp3", status: "failed" }), true)
    assert.equal(isComposerFileSendBlockedByFailure({ id: "doc-1", name: "one.pdf", processingStage: "failed" }), true)
  })
})

describe("long recording chip progress", () => {
  it("shows real % and remaining time instead of a bare Transcribiendo…", () => {
    assert.equal(describeMediaTranscriptionProgress(null), null)
    assert.equal(describeMediaTranscriptionProgress({ stage: "preparing" }), "Preparando audio…")
    assert.equal(describeMediaTranscriptionProgress({ stage: "transcribing", percent: 34.4, etaSeconds: 40 * 60 }), "Transcribiendo 34 % · quedan ~40 min")
    assert.equal(describeMediaTranscriptionProgress({ stage: "transcribing", percent: 80, etaSeconds: 3 * 3600 + 900 }), "Transcribiendo 80 % · quedan ~3 h 15 min")
    assert.equal(describeMediaTranscriptionProgress({ stage: "transcribing", percent: 5 }), "Transcribiendo 5 %")
  })

  it("classifies every supported audio/video format by extension when the browser gives no MIME", () => {
    for (const name of ["nota.caf", "llamada.amr", "voz.m4a", "libro.m4b", "radio.wma", "musica.mka", "ptt.opus", "clase.aiff"]) {
      assert.equal(isAudioComposerFile({ name, type: "" }), true, name)
    }
    for (const name of ["clase.mkv", "cine.wmv", "tv.m2ts", "movil.3gp", "viejo.flv"]) {
      assert.equal(isVideoComposerFile({ name, type: "" }), true, name)
    }
    // `.ts` is TypeScript by name; real MPEG-TS is recognised server-side.
    assert.equal(isVideoComposerFile({ name: "app.ts", type: "video/mp2t" }), false)
  })
})
