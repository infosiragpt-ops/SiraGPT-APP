import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, FileText, LifeBuoy, Mail, ShieldCheck } from "lucide-react"

const SUPPORT_EMAIL = "infosiragpt@gmail.com"

export const metadata: Metadata = {
  title: "Soporte | Sira GPT",
  description: "Ayuda, contacto y recursos oficiales de soporte para Sira GPT.",
}

const SUPPORT_TOPICS = [
  {
    title: "Cuenta y acceso",
    description: "Indica el correo de tu cuenta y describe el mensaje de error, sin compartir contraseñas ni códigos de verificación.",
  },
  {
    title: "Chats, archivos y documentos",
    description: "Incluye el tipo de archivo, la acción solicitada y el resultado esperado. No envíes información sensible que no sea necesaria.",
  },
  {
    title: "Planes y facturación",
    description: "Incluye el identificador del recibo o la fecha del cobro. Nunca envíes números completos de tarjeta.",
  },
] as const

export default function SupportPage() {
  return (
    <main className="h-[var(--app-viewport-height,100dvh)] overflow-y-auto overflow-x-hidden overscroll-y-contain bg-white text-neutral-950">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-5 sm:px-8">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-neutral-700 transition-colors hover:text-neutral-950"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Sira GPT
          </Link>
          <span className="text-sm text-neutral-500">Centro de soporte</span>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-5 py-14 sm:px-8 sm:py-20">
        <section className="max-w-3xl">
          <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50">
            <LifeBuoy className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="text-4xl font-semibold tracking-normal sm:text-5xl">Soporte de Sira GPT</h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-neutral-600 sm:text-lg">
            Cuéntanos qué ocurrió, en qué dispositivo estabas trabajando y qué resultado esperabas. Revisaremos el caso con la información necesaria para reproducirlo.
          </p>
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=Soporte%20Sira%20GPT`}
            className="mt-8 inline-flex min-h-11 items-center gap-2 rounded-md bg-neutral-950 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 focus-visible:ring-offset-2"
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            {SUPPORT_EMAIL}
          </a>
        </section>

        <section className="mt-16 border-t border-neutral-200 pt-10">
          <h2 className="text-xl font-semibold">Información útil para tu solicitud</h2>
          <div className="mt-7 divide-y divide-neutral-200 border-y border-neutral-200">
            {SUPPORT_TOPICS.map((topic) => (
              <div key={topic.title} className="grid gap-2 py-6 sm:grid-cols-[220px_1fr] sm:gap-8">
                <h3 className="font-medium">{topic.title}</h3>
                <p className="text-sm leading-6 text-neutral-600">{topic.description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12 flex flex-col gap-4 border-t border-neutral-200 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">Privacidad y condiciones</h2>
            <p className="mt-1 text-sm text-neutral-600">Consulta cómo tratamos tus datos y las reglas de uso del servicio.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/privacy-policy"
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-neutral-300 px-3.5 py-2 text-sm font-medium hover:bg-neutral-50"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Privacidad
            </Link>
            <Link
              href="/terms"
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-neutral-300 px-3.5 py-2 text-sm font-medium hover:bg-neutral-50"
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              Términos
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
