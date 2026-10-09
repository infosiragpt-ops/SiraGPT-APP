export type ImageJobSnapshot = { jobId: string; status: string; result?: any; error?: string; code?: string }
const aborted = () => Object.assign(new Error("Generación de imagen detenida."), { name: "AbortError" })

/** Poll only the accepted paid job. A transient GET failure never starts a new generation. */
export async function waitForDurableImageJob(options: {
  jobId: string
  get: () => Promise<ImageJobSnapshot>
  cancel: () => Promise<void>
  signal?: AbortSignal
  delay: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  timeoutMs?: number
}) {
  const now = options.now || Date.now
  const deadline = now() + (options.timeoutMs || 210_000)
  while (now() < deadline) {
    if (options.signal?.aborted) { await options.cancel(); throw aborted() }
    try {
      const job = await options.get()
      if (job.jobId !== options.jobId) throw Object.assign(new Error("No se pudo verificar la generación de imagen."), { code: "image_job_mismatch" })
      if (job.status === "completed") {
        if (!job.result) throw Object.assign(new Error("No se pudo recuperar la imagen generada."), { code: "image_job_result_missing" })
        return job.result
      }
      if (job.status === "cancelled") throw aborted()
      if (job.status === "failed" || job.status === "unknown") throw Object.assign(new Error(job.error || "No se pudo generar la imagen. Inténtalo de nuevo."), { code: job.code || "image_job_failed" })
    } catch (error: any) {
      if (options.signal?.aborted) { await options.cancel(); throw aborted() }
      if (error?.name === "AbortError" || error?.code || (Number(error?.status) >= 400 && Number(error?.status) < 500 && ![408, 429].includes(Number(error.status)))) throw error
      // Offline / restart: observe the same durable job after connectivity returns.
    }
    try { await options.delay(1500, options.signal) } catch (error) {
      if (options.signal?.aborted) { await options.cancel(); throw aborted() }
      throw error
    }
  }
  throw Object.assign(new Error("La generación de imagen tardó demasiado. La imagen aparecerá en el chat cuando termine."), { code: "image_job_timeout" })
}
