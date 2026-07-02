import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Descargar Sira GPT — iPhone, Android, Mac y Windows",
  description:
    "Instala Sira GPT en tu dispositivo. Disponible como aplicación web instalable (PWA) en iPhone, Android, Mac y Windows.",
}

/**
 * /descargas — destino real de los botones de descarga de la landing.
 *
 * Sira GPT se distribuye hoy como PWA instalable (manifest + service worker
 * ya publicados), así que esta página guía la instalación por plataforma en
 * lugar de dejar los CTA muertos con href="#". Cuando existan binarios o
 * fichas de store, cada tarjeta enlaza directo desde aquí.
 */

const PLATFORMS: {
  id: string
  name: string
  badge: string
  steps: string[]
}[] = [
  {
    id: "iphone",
    name: "iPhone / iPad",
    badge: "Safari",
    steps: [
      "Abre siragpt.com en Safari.",
      "Toca el botón Compartir (el cuadrado con la flecha hacia arriba).",
      "Elige “Añadir a pantalla de inicio” y confirma.",
      "Sira GPT queda instalado como app, a pantalla completa.",
    ],
  },
  {
    id: "android",
    name: "Android",
    badge: "Chrome",
    steps: [
      "Abre siragpt.com en Chrome.",
      "Toca el menú ⋮ (arriba a la derecha).",
      "Elige “Instalar aplicación” (o “Añadir a pantalla principal”).",
      "Confirma y ábrelo desde tu launcher como cualquier app.",
    ],
  },
  {
    id: "mac",
    name: "Mac",
    badge: "Chrome · Edge · Safari",
    steps: [
      "Abre siragpt.com en Chrome, Edge o Safari.",
      "En Chrome/Edge: haz clic en el icono de instalar de la barra de direcciones.",
      "En Safari: menú Archivo → “Añadir al Dock”.",
      "Sira GPT se abre en su propia ventana, como app nativa.",
    ],
  },
  {
    id: "windows",
    name: "Windows",
    badge: "Chrome · Edge",
    steps: [
      "Abre siragpt.com en Chrome o Edge.",
      "Haz clic en el icono de instalar de la barra de direcciones (o menú → Aplicaciones → Instalar).",
      "Confirma la instalación.",
      "Encuéntralo en el menú Inicio y ánclalo a la barra de tareas.",
    ],
  },
]

export default function DescargasPage() {
  return (
    <div className="min-h-screen bg-white text-neutral-950 dark:bg-neutral-950 dark:text-white">
      <main className="mx-auto w-full max-w-3xl px-5 py-14 md:py-20">
        <Link
          href="/"
          className="text-sm text-neutral-500 transition hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"
        >
          ← Volver al inicio
        </Link>

        <h1 className="mt-6 text-3xl font-bold tracking-tight md:text-4xl">
          Instala Sira GPT en tu dispositivo
        </h1>
        <p className="mt-3 max-w-xl text-neutral-600 dark:text-neutral-400">
          Sira GPT funciona como aplicación instalable en todas tus pantallas:
          mismo chat, misma cuenta, sin esperar a la tienda de apps.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {PLATFORMS.map(({ id, name, badge, steps }) => (
            <section
              key={id}
              id={id}
              className="scroll-mt-24 rounded-2xl border border-neutral-200 p-5 dark:border-white/10"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-lg font-bold">{name}</h2>
                <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                  {badge}
                </span>
              </div>
              <ol className="mt-3 space-y-2 text-sm text-neutral-600 dark:text-neutral-400">
                {steps.map((step, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="font-semibold text-neutral-900 dark:text-white">{i + 1}.</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>

        <div className="mt-10 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          <Link
            href="/auth/login"
            className="inline-flex min-h-12 items-center justify-center rounded-xl bg-neutral-950 px-6 py-3 font-bold text-white transition hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
          >
            O úsalo ahora en la web
          </Link>
          <p className="text-xs text-neutral-400">
            Las apps de las tiendas oficiales están en camino.
          </p>
        </div>
      </main>
    </div>
  )
}
