"use client"

import * as React from "react"
import { Compass, PlusSquare, Share, Smartphone } from "lucide-react"
import { detectInstallSurface, isStandaloneDisplay, type InstallSurface } from "@/lib/mobile-install"

const STEPS = [
  {
    icon: Compass,
    title: "Abre siragpt.com en Safari",
    detail: "La instalación solo aparece en Safari. Si estás en Chrome u otro navegador del iPhone, copia el enlace y ábrelo en Safari.",
  },
  {
    icon: Share,
    title: "Toca el botón Compartir",
    detail: "Es el cuadrado con la flecha hacia arriba, en la barra inferior de Safari.",
  },
  {
    icon: PlusSquare,
    title: "Elige “Añadir a pantalla de inicio”",
    detail: "Desplázate en el menú de compartir hasta ver la opción con el icono de un cuadrado con un +.",
  },
  {
    icon: Smartphone,
    title: "Confirma con “Añadir”",
    detail: "SiraGPT aparece como app en tu pantalla de inicio, a pantalla completa y con tu misma cuenta.",
  },
]

/**
 * First-class iPhone install guide. Safari on iOS never fires
 * `beforeinstallprompt`, so an install button is impossible there — the
 * honest UX is teaching the share-sheet gesture with big, numbered steps.
 * When the visitor is actually on an iPhone the card highlights itself.
 */
export function IphoneInstallCard() {
  const [surface, setSurface] = React.useState<InstallSurface | null>(null)
  const [installed, setInstalled] = React.useState(false)

  React.useEffect(() => {
    setSurface(detectInstallSurface(window.navigator.userAgent))
    setInstalled(isStandaloneDisplay())
  }, [])

  const onIphone = surface === "ios-safari" || surface === "ios-other-browser"
  const highlighted = onIphone && !installed

  return (
    <article
      id="iphone"
      className={`scroll-mt-24 border p-5 ${
        highlighted
          ? "border-violet-400 ring-2 ring-violet-500/25 dark:border-violet-500"
          : "border-neutral-200 dark:border-white/10"
      }`}
      style={{ borderRadius: 8 }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-white/10">
            <Smartphone className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-lg font-bold">SiraGPT en tu iPhone</h2>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Instalación desde Safari, sin App Store</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300">
          Disponible hoy
        </span>
      </div>

      {installed ? (
        <p className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          Ya estás usando SiraGPT instalado como app. No necesitas repetir estos pasos.
        </p>
      ) : null}

      {highlighted ? (
        <p className="mt-4 rounded-lg bg-violet-50 p-3 text-sm font-medium text-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
          {surface === "ios-safari"
            ? "Estás en un iPhone: sigue estos pasos ahora mismo, toma menos de un minuto."
            : "Estás en un iPhone, pero este navegador no puede instalar la app. Abre esta página en Safari y sigue los pasos."}
        </p>
      ) : null}

      <ol className="mt-5 space-y-2">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            className="flex min-h-14 items-start gap-3 rounded-lg bg-neutral-50 p-3 dark:bg-white/5"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-950 text-sm font-bold text-white dark:bg-white dark:text-neutral-950">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-semibold leading-snug">
                <step.icon className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden="true" />
                {step.title}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </article>
  )
}
