
/** OLA200_WAVE_G FE-097 — abort MediaRecorder / audio stream on unmount; no leak. */
export function abortAudioStream(args: { recorder?: { state?: string; stop?: () => void; stream?: { getTracks?: () => Array<{ stop?: () => void }> } } | null; stream?: { getTracks?: () => Array<{ stop?: () => void }> } | null; audio?: { pause?: () => void; src?: string } | null }): void {
  try {
    const rec = args.recorder
    if (rec && rec.state && rec.state !== "inactive" && typeof rec.stop === "function") rec.stop()
    const tracks = rec?.stream?.getTracks?.() || args.stream?.getTracks?.() || []
    for (const track of tracks) { try { track.stop?.() } catch { /* ignore */ } }
    if (args.audio) { try { args.audio.pause?.() } catch { /* ignore */ } try { args.audio.src = "" } catch { /* ignore */ } }
  } catch { /* ignore */ }
}
