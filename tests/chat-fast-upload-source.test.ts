import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const read = (...segments: string[]) => fs.readFileSync(path.join(process.cwd(), ...segments), "utf8")

const chatInterface = read("components", "chat-interface-enhanced.tsx")
const apiSource = read("lib", "api.ts")
const resumable = read("lib", "composer", "resumable-upload.ts")
const ingest = read("lib", "attachment-ingest.ts")
const filesRoute = read("backend", "src", "routes", "files.js")
const chunkedStore = read("backend", "src", "services", "chunked-upload-store.js")
const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> }

/**
 * «Carga tipo WhatsApp»: the composer extracts the audio of a recording in
 * the browser before uploading it, uploads its sub-batches a few at a time
 * instead of one after another, accepts 100 recordings per message, and the
 * server keeps what the audio stands for. Source pins: logic only, no UI.
 */
describe("fast upload wiring (composer + transport + server)", () => {
  it("extracts media in the browser inside each sub-batch and uploads the extracted file with its metadata", () => {
    assert.match(chatInterface, /import \{ EXTRACTION_PROGRESS_SHARE, prepareMediaForUpload \} from "@\/lib\/media\/prepare-upload-media"/)
    assert.match(chatInterface, /const prepared = await prepareMediaForUpload\(chunk\.files, \{\s*\n\s*signal: chunkAbort\.signal,/, "the chip's cancel aborts the extraction too")
    assert.match(chatInterface, /const files = prepared\.files;/)
    assert.match(chatInterface, /clientExtracted: prepared\.clientExtracted\.get\(files\[0\]\) \?\? null,/, "the chunked upload announces the source at init")
    assert.match(chatInterface, /const extractedByIndex = files\.map\(\(f\) => \(prepared\.clientExtracted\.get\(f\) as Record<string, unknown> \| undefined\) \?\? null\);/, "aligned with the multipart parts")
    assert.match(chatInterface, /\.\.\.\(extractedByIndex\.some\(Boolean\) \? \{ clientExtracted: extractedByIndex \} : \{\}\),/, "the multipart upload carries one entry per file")
    assert.match(chatInterface, /\.\.\.\(isExtracted\(files\[0\]\) \? \{ resume: false \} : \{\}\),/, "a re-extraction never joins an older session's parts")
    assert.match(chatInterface, /if \(pct <= \(extractionPct\.get\(index\) \?\? -1\)\) return;/, "only a higher whole percentage reaches React")
    assert.match(chatInterface, /const spentExtraction = \(idx: number\) => isExtracted\(files\[idx\]\) \|\| extractionPct\.has\(idx\);/)
    assert.match(chatInterface, /const shifted = spentExtraction\(idx\) \? Math\.round\(EXTRACTION_PROGRESS_SHARE \+ \(pct \* \(100 - EXTRACTION_PROGRESS_SHARE\)\) \/ 100\) : pct;/, "upload progress fills the share left after the extraction, also when the original goes")
    assert.doesNotMatch(chatInterface, /apiClient\.uploadFileChunked\(chunk\.files\[0\]/, "never the original once an extraction replaced it")
  })

  it("remembers a video only once its extracted audio uploaded, so attaching it again uploads it whole", () => {
    assert.match(chatInterface, /import \{ extractedSourceMemory \} from "@\/lib\/media\/extracted-source-memory"/)
    const success = chatInterface.indexOf("const failedServerFiles = response.files.filter((f: any) => f?.success === false);")
    const failed = chatInterface.indexOf("toast.error('La subida falló. Toca el ícono de reintento en el archivo.');")
    const remember = chatInterface.indexOf("extractedSourceMemory().remember(chunk.files[idx]);")
    assert.ok(failed > 0 && success > failed && remember > success, "after the server answered with files, never before the upload")
    assert.match(chatInterface, /if \(isExtracted\(file\) && response\.files\[idx\]\?\.success !== false && mediaKindOf\(chunk\.files\[idx\]\) === 'video'\) \{/)
  })

  it("runs the upload sub-batches through the bounded parallel queue instead of a serial loop", () => {
    assert.match(chatInterface, /import \{ DEFAULT_PARALLEL_UPLOADS, runUploadQueue, uploadConcurrencyFor \} from "@\/lib\/composer\/upload-scheduler"/)
    assert.match(chatInterface, /await runUploadQueue\(\s*\n\s*uploadChunks\.map\(\(chunk, chunkIndex\) => \(\{ id: String\(chunkIndex\), run: \(signal: AbortSignal\) => processChunk\(chunk, chunkIndex, signal\) \}\)\),\s*\n\s*\{ concurrency: uploadConcurrencyFor\(uploadChunks\.length, DEFAULT_PARALLEL_UPLOADS\) \},\s*\n\s*\)\.done;/)
    assert.doesNotMatch(chatInterface, /for \(let chunkIndex = 0; chunkIndex < uploadChunks\.length; chunkIndex \+= 1\)/)
    // Every early exit of the former loop body is a return of processChunk now.
    assert.match(chatInterface, /toast\.error\('La subida falló\. Toca el ícono de reintento en el archivo\.'\);\s*\n\s*return;/)
  })

  it("accepts 100 recordings per message, aligned with the backend batch cap", () => {
    assert.match(ingest, /export const MAX_MEDIA_FILES_PER_MESSAGE = 100/)
    assert.match(ingest, /mediaCount >= MAX_MEDIA_FILES_PER_MESSAGE/)
    assert.doesNotMatch(ingest, /Máximo 50 audios/)
  })

  it("threads clientExtracted through the chunked init, the multipart form and the server session", () => {
    assert.match(resumable, /clientExtracted\?: Record<string, unknown> \| null/)
    assert.match(resumable, /\.\.\.\(opts\.clientExtracted \? \{ clientExtracted: opts\.clientExtracted \} : \{\}\),/)
    assert.match(apiSource, /if \(opts\.clientExtracted && opts\.clientExtracted\.some\(Boolean\)\) formData\.append\('clientExtracted', JSON\.stringify\(opts\.clientExtracted\)\);/)
    assert.match(apiSource, /clientExtracted: opts\.clientExtracted \?\? null,/)
    assert.match(filesRoute, /const clientExtracted = clientExtractedMetadata\.parseClientExtracted\(req\.body\?\.clientExtracted\);/)
    assert.match(filesRoute, /const extracted = clientExtractedMetadata\.parseClientExtractedField\(req\.body\?\.clientExtracted\);/)
    assert.match(filesRoute, /const meta = extracted\.byIndex\[index\];/, "matched by part index, the name map only for older tabs")
    assert.match(filesRoute, /patch: \{ clientExtracted: file\.clientExtracted \}/, "persisted in DocumentAnalysis.metadata through the shared merge helper")
    assert.match(chunkedStore, /clientExtracted: meta\.clientExtracted \|\| null,/)
    assert.match(chunkedStore, /\.\.\.\(clientExtracted && typeof clientExtracted === 'object' \? \{ clientExtracted \} : \{\}\),/)
  })

  it("mediabunny is pinned (MPL-2.0, dynamically imported) and never loaded eagerly by the composer", () => {
    assert.equal(pkg.dependencies.mediabunny, "1.65.2")
    const extractor = read("lib", "media", "client-audio-extract.ts")
    assert.match(extractor, /const defaultLoader = \(\): Promise<MediabunnyModule> => import\("mediabunny"\)/)
    // Type-only imports are erased; nothing else loads the library eagerly.
    assert.doesNotMatch(extractor.replace(/^import type [^\n]*$/gm, ""), /from "mediabunny"/)
    assert.doesNotMatch(chatInterface, /from "mediabunny"/)
    assert.doesNotMatch(apiSource, /from "mediabunny"/)
  })
})
