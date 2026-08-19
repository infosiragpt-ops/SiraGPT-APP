export type UploadBatchLimits = Readonly<{
  maxFiles: number
  maxBytes: number
}>

export type UploadFileLike = Readonly<{
  size?: number | null
}>

export type UploadChunk<TFile, TTemp> = {
  files: TFile[]
  temps: TTemp[]
}

export const COMPOSER_UPLOAD_BATCH_LIMITS: UploadBatchLimits = Object.freeze({
  maxFiles: 50,
  maxBytes: 220 * 1024 * 1024,
})

function normalizedFileBytes(file: UploadFileLike): number {
  const size = Number(file.size ?? 0)
  return Number.isFinite(size) && size > 0 ? size : 0
}

function assertValidLimits(limits: UploadBatchLimits): void {
  if (!Number.isInteger(limits.maxFiles) || limits.maxFiles < 1) {
    throw new RangeError("maxFiles must be a positive integer")
  }
  if (!Number.isFinite(limits.maxBytes) || limits.maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive number")
  }
}

/**
 * Split one composer selection into request-sized batches while preserving the
 * one-to-one relationship between browser files and optimistic upload chips.
 */
export function buildComposerUploadChunks<TFile extends UploadFileLike, TTemp>(
  files: readonly TFile[],
  tempFiles: readonly TTemp[],
  limits: UploadBatchLimits = COMPOSER_UPLOAD_BATCH_LIMITS,
): Array<UploadChunk<TFile, TTemp>> {
  assertValidLimits(limits)
  if (files.length !== tempFiles.length) {
    throw new RangeError("files and tempFiles must have the same length")
  }

  const chunks: Array<UploadChunk<TFile, TTemp>> = []
  let currentFiles: TFile[] = []
  let currentTemps: TTemp[] = []
  let currentBytes = 0

  files.forEach((file, index) => {
    const fileBytes = normalizedFileBytes(file)
    const wouldOverflowCount = currentFiles.length >= limits.maxFiles
    const wouldOverflowBytes =
      currentFiles.length > 0 && currentBytes + fileBytes > limits.maxBytes

    if (wouldOverflowCount || wouldOverflowBytes) {
      chunks.push({ files: currentFiles, temps: currentTemps })
      currentFiles = []
      currentTemps = []
      currentBytes = 0
    }

    currentFiles.push(file)
    currentTemps.push(tempFiles[index])
    currentBytes += fileBytes
  })

  if (currentFiles.length > 0) {
    chunks.push({ files: currentFiles, temps: currentTemps })
  }
  return chunks
}
