/**
 * Offline fallback page for the PWA service worker.
 *
 * The minimal `public/sw.js` falls back to this route when an HTML
 * navigation can't reach the network. Keep it static and dependency-
 * free (no client hooks, no fonts, no remote assets) so it renders
 * even when the network is fully offline.
 */
export const dynamic = "force-static"

export const metadata = {
  title: "Sin conexión — Sira GPT",
  description: "Estás sin conexión. Recupera Internet para volver a usar Sira GPT.",
}

export default function OfflinePage() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background p-6 text-foreground">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Sin conexión</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          No podemos llegar a Sira GPT ahora mismo. Comprueba tu conexión a Internet
          y vuelve a intentarlo. Tus chats guardados en este dispositivo siguen aquí;
          no hay sincronización automática al volver online.
        </p>
      </div>
    </main>
  )
}
