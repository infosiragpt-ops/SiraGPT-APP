import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, CircleDashed, FlaskConical, Globe2, Laptop } from "lucide-react"
import { DesktopDownloadCard } from "@/components/desktop/desktop-download-card"
import { AndroidDownloadCard } from "@/components/mobile/android-download-card"
import { IphoneInstallCard } from "@/components/mobile/iphone-install-card"
import { MobileInstallCoach } from "@/components/mobile/mobile-install-coach"

export const metadata: Metadata = {
  title: "Descargar SiraGPT para iPhone, Android, Mac y Windows",
  description:
    "Instala SiraGPT en tu iPhone desde Safari, descarga el APK para Android o las aplicaciones de escritorio para macOS y Windows.",
}

const APP_STORE_ISSUE_URL = "https://github.com/infosiragpt-ops/SiraGPT-APP/issues/6"

const APP_STORE_OWNER_STEPS = [
  "Inicio de sesión del propietario con su Apple ID y verificación 2FA.",
  "Membresía de pago activa en el Apple Developer Program.",
  "Alta de la app com.siragpt.app en App Store Connect.",
  "Firma nativa (certificados y provisioning) y subida del IPA firmado.",
]

/**
 * "App Store (nativa Capacitor)" status card. Publishing is blocked on
 * owner-only Apple vendor steps (docs/mobile-store-release.md, issue #6),
 * so this card is deliberately honest: no official store badge and no
 * store URL exist here until the listing is real.
 */
function AppStoreStatusCard() {
  return (
    <article className="border border-dashed border-neutral-300 p-5 dark:border-white/15" style={{ borderRadius: 8 }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-neutral-100 dark:bg-white/10">
            <CircleDashed className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-lg font-bold">App Store (nativa Capacitor)</h3>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">La app nativa existe; la publicación depende del propietario</p>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
          Pendiente
        </span>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        La versión nativa para iPhone (Capacitor, <code className="text-xs">com.siragpt.app</code>) ya compila. Para que
        aparezca en el App Store faltan estos pasos, que solo puede completar el propietario de la cuenta (
        <a href={APP_STORE_ISSUE_URL} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer">issue #6</a>):
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        {APP_STORE_OWNER_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>

      <div className="mt-4 flex gap-2.5 border-t border-neutral-200 pt-4 text-xs leading-relaxed text-neutral-500 dark:border-white/10 dark:text-neutral-400">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          El ZIP del iPhone Simulator publicado en GitHub es solo para QA en macOS: no puede instalarse en un iPhone
          físico. Mientras tanto, la instalación desde Safari (arriba) es la vía oficial en iPhone.
        </p>
      </div>
    </article>
  )
}

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
          <p className="text-xs font-semibold uppercase text-neutral-500">Descargas</p>
          <h1 className="mt-3 text-3xl font-bold md:text-4xl">SiraGPT en tu iPhone, Android, Mac y Windows</h1>
          <p className="mt-4 text-base leading-relaxed text-neutral-600 dark:text-neutral-400">
            La misma cuenta y las mismas conversaciones en todos tus dispositivos. En el teléfono se instala en menos
            de un minuto; en la computadora descargas la aplicación de escritorio.
          </p>
        </header>

        <section className="mt-10" aria-label="iPhone y Android">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <IphoneInstallCard />
            <AndroidDownloadCard />
          </div>
          <div className="mt-4">
            <AppStoreStatusCard />
          </div>
        </section>

        <section className="mt-12 border-t border-neutral-200 pt-10 dark:border-white/10" aria-label="Mac y Windows">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-neutral-100 dark:bg-white/10">
              <Laptop className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-bold">Mac y Windows</h2>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Aplicaciones de escritorio con ventana propia</p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <DesktopDownloadCard platform="macos" />
            <DesktopDownloadCard platform="windows" />
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

      <MobileInstallCoach />
    </div>
  )
}
