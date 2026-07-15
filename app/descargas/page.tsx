import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, Globe2, Smartphone } from "lucide-react"
import { DesktopDownloadCard } from "@/components/desktop/desktop-download-card"

export const metadata: Metadata = {
  title: "Descargar SiraGPT para Mac y Windows",
  description: "Descarga la aplicación de escritorio de SiraGPT para macOS y Windows, o instala la versión web en iPhone y Android.",
}

const MOBILE_PLATFORMS = [
  {
    id: "iphone",
    name: "iPhone / iPad",
    browser: "Safari",
    steps: "Abre siragpt.com, toca Compartir y elige Añadir a pantalla de inicio.",
  },
  {
    id: "android",
    name: "Android",
    browser: "Chrome",
    steps: "Abre siragpt.com, abre el menú del navegador y elige Instalar aplicación.",
  },
]

export default function DescargasPage() {
  return (
    <div className="min-h-screen bg-white text-neutral-950 dark:bg-neutral-950 dark:text-white">
      <main className="mx-auto w-full max-w-5xl px-5 py-12 md:px-8 md:py-16">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-neutral-500 transition hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Volver al inicio
        </Link>

        <header className="mt-8 max-w-2xl">
          <p className="text-xs font-semibold uppercase text-neutral-500">Aplicaciones de escritorio</p>
          <h1 className="mt-3 text-3xl font-bold md:text-4xl">SiraGPT en tu computadora</h1>
          <p className="mt-4 text-base leading-relaxed text-neutral-600 dark:text-neutral-400">
            Accede directamente al chat con la misma cuenta y conversaciones. La aplicación conserva tu ventana, integra navegación nativa y se recupera cuando vuelve la conexión.
          </p>
        </header>

        <div className="mt-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <DesktopDownloadCard platform="macos" />
          <DesktopDownloadCard platform="windows" />
        </div>

        <section className="mt-12 border-t border-neutral-200 pt-10 dark:border-white/10">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-neutral-100 dark:bg-white/10">
              <Smartphone className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-bold">iPhone y Android</h2>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Instalación web desde el navegador</p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {MOBILE_PLATFORMS.map((platform) => (
              <article key={platform.id} id={platform.id} className="border border-neutral-200 p-4 dark:border-white/10" style={{ borderRadius: 8 }}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">{platform.name}</h3>
                  <span className="text-[10px] font-medium uppercase text-neutral-400">{platform.browser}</span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{platform.steps}</p>
              </article>
            ))}
          </div>
        </section>

        <div className="mt-10 flex flex-col items-start gap-3 border-t border-neutral-200 pt-8 sm:flex-row sm:items-center dark:border-white/10">
          <Link
            href="/auth/login"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-neutral-300 px-5 py-2.5 text-sm font-semibold transition hover:bg-neutral-100 dark:border-white/20 dark:hover:bg-white/10"
          >
            <Globe2 className="h-4 w-4" aria-hidden="true" />
            Continuar en la web
          </Link>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Tu historial se sincroniza con la misma cuenta.</p>
        </div>
      </main>
    </div>
  )
}
