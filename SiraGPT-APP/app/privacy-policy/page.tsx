"use client"

import React, { useEffect } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Cookie,
  Database,
  FileText,
  LockKeyhole,
  Mail,
  Scale,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

const ACCENT = "#FF0000";
const UPDATED_AT = "28 de junio de 2026";

type Principle = {
  title: string;
  text: string;
  icon: LucideIcon;
};

type PrivacySection = {
  id: string;
  title: string;
  icon: LucideIcon;
  body: React.ReactNode;
};

const PRINCIPLES: Principle[] = [
  {
    title: "Transparencia",
    text: "Explicamos qué datos usamos, para qué y con qué proveedores se procesan.",
    icon: FileText,
  },
  {
    title: "Minimización",
    text: "Solicitamos la información necesaria para operar Sira GPT y mantenerlo seguro.",
    icon: Database,
  },
  {
    title: "Control",
    text: "Puedes solicitar acceso, corrección, exportación o eliminación de tus datos.",
    icon: UserCheck,
  },
  {
    title: "Seguridad",
    text: "Aplicamos controles técnicos y operativos para proteger cuentas y contenido.",
    icon: ShieldCheck,
  },
];

const SECTIONS: PrivacySection[] = [
  {
    id: "alcance",
    title: "1. Alcance y responsable",
    icon: Scale,
    body: (
      <>
        <p>
          Esta Política de Privacidad describe cómo Sira GPT trata los datos
          personales cuando usas el sitio, la aplicación web, las funciones de
          IA, las integraciones opcionales y los servicios relacionados
          disponibles en{" "}
          <ExternalLink href="https://siragpt.com">siragpt.com</ExternalLink>.
        </p>
        <p>
          El responsable del tratamiento es Sira GPT. Para consultas,
          solicitudes de privacidad o dudas sobre este documento, escríbenos a{" "}
          <ExternalLink href="mailto:infosiragpt@gmail.com">
            infosiragpt@gmail.com
          </ExternalLink>
          .
        </p>
      </>
    ),
  },
  {
    id: "datos",
    title: "2. Datos personales que tratamos",
    icon: Database,
    body: (
      <>
        <p>
          Recopilamos y procesamos datos de acuerdo con las funciones que
          decides usar:
        </p>
        <BulletList
          items={[
            <>
              <strong>Datos de cuenta:</strong> nombre, correo electrónico,
              contraseña cifrada o identificadores de autenticación, preferencias,
              plan, estado de suscripción y configuración de idioma.
            </>,
            <>
              <strong>Contenido del usuario:</strong> prompts, mensajes,
              conversaciones, archivos, imágenes, documentos, proyectos y
              resultados que generas o subes para usar las funciones de IA.
            </>,
            <>
              <strong>Datos técnicos y de uso:</strong> dirección IP,
              identificadores de sesión, navegador, dispositivo, sistema
              operativo, registros de acceso, consumo de tokens, límites,
              errores y eventos necesarios para seguridad y soporte.
            </>,
            <>
              <strong>Datos de facturación:</strong> identificadores de cliente,
              plan, estado de pago y recibos procesados por proveedores de pago.
              No almacenamos números completos de tarjeta.
            </>,
            <>
              <strong>Datos de integraciones:</strong> información autorizada por
              ti al conectar servicios de terceros, como Google, solo para
              ejecutar la función que activaste.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: "finalidades",
    title: "3. Para qué usamos tus datos",
    icon: CheckCircle2,
    body: (
      <>
        <p>Usamos tus datos para prestar, proteger y mejorar el servicio:</p>
        <BulletList
          items={[
            "Crear y mantener tu cuenta, autenticarte y conservar tus preferencias.",
            "Procesar tus solicitudes con el modelo de IA o herramienta que elijas.",
            "Guardar conversaciones, archivos y proyectos cuando la función lo requiere.",
            "Gestionar planes, límites de uso, pagos, facturación y soporte al cliente.",
            "Prevenir fraude, abuso, uso no autorizado, incidentes de seguridad y actividad contraria a nuestros términos.",
            "Generar métricas agregadas, diagnósticos técnicos y analíticas de producto sin vender tus datos personales.",
            "Cumplir obligaciones legales, regulatorias, contables o requerimientos válidos de autoridades competentes.",
          ]}
        />
      </>
    ),
  },
  {
    id: "modelos",
    title: "4. Contenido enviado a modelos de IA",
    icon: LockKeyhole,
    body: (
      <>
        <p>
          Sira GPT funciona como una plataforma multi-modelo. Cuando eliges un
          modelo o herramienta de IA, el contenido estrictamente necesario para
          responder tu solicitud puede enviarse al proveedor correspondiente,
          por ejemplo OpenAI, Anthropic, Google Gemini, xAI, DeepSeek,
          OpenRouter u otros modelos disponibles en el catálogo.
        </p>
        <p>
          No vendemos tu contenido ni lo usamos para entrenar modelos propios
          sin tu consentimiento expreso. Los proveedores externos pueden tratar
          el contenido de acuerdo con sus propias políticas y contratos. Cuando
          el proveedor ofrece controles de privacidad, configuramos el servicio
          con opciones razonables orientadas a proteger los datos del usuario.
        </p>
        <p>
          Evita enviar información sensible, confidencial o de terceros si no es
          necesaria para la tarea. Tú controlas qué contenido compartes con la
          plataforma y qué modelo eliges para procesarlo.
        </p>
      </>
    ),
  },
  {
    id: "proveedores",
    title: "5. Proveedores y terceros",
    icon: ShieldCheck,
    body: (
      <>
        <p>
          Para operar Sira GPT usamos proveedores que procesan datos en nuestro
          nombre o como servicios externos seleccionados por el usuario:
        </p>
        <BulletList
          items={[
            "Proveedores de modelos de IA, generación multimodal, transcripción, búsqueda o herramientas conectadas.",
            "Infraestructura de alojamiento, base de datos, almacenamiento, colas, caché, redes y seguridad.",
            "Servicios de autenticación, como Google OAuth, cuando eliges iniciar sesión o conectar una integración.",
            "Proveedores de pago y facturación, como Stripe o Mercado Pago, según el plan y el país disponible.",
            "Herramientas de analítica, monitoreo y errores, como PostHog o Sentry cuando están configuradas.",
          ]}
        />
        <p>
          Exigimos que los proveedores accedan solo a la información necesaria
          para prestar su servicio. No vendemos tus datos personales.
        </p>
      </>
    ),
  },
  {
    id: "google",
    title: "6. Inicio de sesión e integraciones con Google",
    icon: UserCheck,
    body: (
      <>
        <p>
          Si eliges continuar con Google, solicitamos el perfil básico y el
          correo electrónico necesarios para crear o acceder a tu cuenta. No
          leemos, enviamos ni modificamos correos, calendarios o archivos por el
          simple hecho de iniciar sesión con Google.
        </p>
        <p>
          Cualquier acceso adicional a Gmail, Calendar, Drive u otros servicios
          de Google es opcional, se solicita por separado y se usa únicamente
          para ejecutar la acción que autorizaste dentro de Sira GPT. Puedes
          revocar esos permisos desde tu cuenta de Google o desde la
          configuración del servicio cuando la opción esté disponible.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "7. Cookies y analíticas",
    icon: Cookie,
    body: (
      <>
        <p>
          Usamos cookies y tecnologías similares necesarias para mantener tu
          sesión, recordar preferencias, proteger formularios, prevenir abuso y
          operar funciones esenciales. También podemos usar analíticas limitadas
          para entender rendimiento, errores y uso agregado del producto.
        </p>
        <p>
          No usamos cookies publicitarias de terceros ni vendemos perfiles de
          navegación. Puedes controlar cookies desde tu navegador, aunque
          desactivar cookies esenciales puede impedir que el servicio funcione
          correctamente.
        </p>
      </>
    ),
  },
  {
    id: "retencion",
    title: "8. Conservación y eliminación",
    icon: FileText,
    body: (
      <>
        <p>
          Conservamos los datos mientras tu cuenta esté activa o mientras sean
          necesarios para prestar el servicio, cumplir obligaciones legales,
          resolver disputas, mantener seguridad o hacer cumplir nuestros
          términos.
        </p>
        <p>
          Puedes solicitar la eliminación de tu cuenta desde la configuración
          cuando esté disponible o escribiendo a{" "}
          <ExternalLink href="mailto:infosiragpt@gmail.com">
            infosiragpt@gmail.com
          </ExternalLink>
          . Tras una solicitud válida, eliminamos o anonimizamos datos personales
          en un plazo razonable, salvo información que debamos conservar por
          motivos legales, contables, de seguridad o copias de respaldo con
          ciclos normales de retención.
        </p>
      </>
    ),
  },
  {
    id: "seguridad",
    title: "9. Seguridad",
    icon: LockKeyhole,
    body: (
      <>
        <p>
          Aplicamos medidas técnicas y organizativas razonables para proteger
          los datos, incluyendo cifrado en tránsito mediante HTTPS/TLS, tokens
          de sesión firmados, controles de acceso, protección de credenciales,
          monitoreo, registros de auditoría y revisiones operativas.
        </p>
        <p>
          Ningún sistema conectado a internet es completamente infalible. Si
          detectas una vulnerabilidad o actividad sospechosa, contáctanos de
          inmediato para investigarla.
        </p>
      </>
    ),
  },
  {
    id: "transferencias",
    title: "10. Transferencias internacionales",
    icon: Scale,
    body: (
      <>
        <p>
          Sira GPT y sus proveedores pueden procesar datos en distintos países.
          Cuando corresponde, usamos proveedores con medidas contractuales,
          técnicas y organizativas orientadas a proteger la información conforme
          a la normativa aplicable.
        </p>
      </>
    ),
  },
  {
    id: "derechos",
    title: "11. Tus derechos",
    icon: UserCheck,
    body: (
      <>
        <p>
          Según tu jurisdicción, puedes tener derecho a acceder, corregir,
          actualizar, exportar, limitar, oponerte o solicitar la eliminación de
          tus datos personales. También puedes retirar consentimientos cuando el
          tratamiento dependa de ellos.
        </p>
        <p>
          Para ejercer tus derechos, escríbenos a{" "}
          <ExternalLink href="mailto:infosiragpt@gmail.com">
            infosiragpt@gmail.com
          </ExternalLink>
          . Podemos pedir información razonable para verificar tu identidad y
          proteger tu cuenta antes de completar la solicitud.
        </p>
      </>
    ),
  },
  {
    id: "menores",
    title: "12. Menores de edad",
    icon: ShieldCheck,
    body: (
      <>
        <p>
          Sira GPT no está dirigido a menores de 18 años ni a personas que no
          tengan capacidad legal para aceptar nuestros términos. No recopilamos
          intencionalmente datos de menores. Si crees que un menor nos
          proporcionó información personal, contáctanos para revisarlo.
        </p>
      </>
    ),
  },
  {
    id: "cambios",
    title: "13. Cambios a esta política",
    icon: FileText,
    body: (
      <>
        <p>
          Podemos actualizar esta Política de Privacidad para reflejar cambios
          en el producto, proveedores, obligaciones legales o prácticas de
          seguridad. Publicaremos la versión vigente en esta página y, cuando el
          cambio sea relevante, haremos esfuerzos razonables para notificarlo en
          el sitio o por correo electrónico.
        </p>
      </>
    ),
  },
  {
    id: "contacto",
    title: "14. Contacto",
    icon: Mail,
    body: (
      <>
        <p>
          Para preguntas sobre privacidad, seguridad o tratamiento de datos
          personales, contáctanos en{" "}
          <ExternalLink href="mailto:infosiragpt@gmail.com">
            infosiragpt@gmail.com
          </ExternalLink>
          .
        </p>
        <p>
          También puedes revisar los{" "}
          <InternalLink href="/terms">Términos del Servicio</InternalLink> para
          entender las reglas de uso de Sira GPT.
        </p>
      </>
    ),
  },
];

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      style={{ color: ACCENT }}
      className="font-medium underline decoration-[#FF0000]/50 underline-offset-4 transition-colors hover:text-white hover:decoration-[#FF0000]"
    >
      {children}
    </a>
  );
}

function InternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{ color: ACCENT }}
      className="font-medium underline decoration-[#FF0000]/50 underline-offset-4 transition-colors hover:text-white hover:decoration-[#FF0000]"
    >
      {children}
    </Link>
  );
}

function BulletList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mt-4 space-y-3 pl-5 text-slate-300 marker:text-[#FF0000]">
      {items.map((item, index) => (
        <li key={index} className="list-disc pl-1 leading-7">
          {item}
        </li>
      ))}
    </ul>
  );
}

const PrivacyPolicyPage = () => {
  useEffect(() => {
    const htmlEl = document.documentElement;
    const bodyEl = document.body;

    htmlEl.style.overflow = "auto";
    htmlEl.style.height = "auto";
    htmlEl.style.overscrollBehavior = "auto";

    bodyEl.style.overflow = "auto";
    bodyEl.style.height = "auto";
    bodyEl.style.overscrollBehavior = "auto";

    return () => {
      htmlEl.style.overflow = "";
      htmlEl.style.height = "";
      htmlEl.style.overscrollBehavior = "";

      bodyEl.style.overflow = "";
      bodyEl.style.height = "";
      bodyEl.style.overscrollBehavior = "";
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#070707] text-white">
      <div aria-hidden className="h-1 w-full bg-[#FF0000]" />

      <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-6 lg:px-8 lg:py-20">
        <motion.header
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="mb-12 border-b border-white/10 pb-10"
        >
          <Link
            href="/"
            className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-slate-300 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Inicio
          </Link>

          <p
            className="mb-4 text-sm font-semibold uppercase text-[#FF0000]"
            style={{ color: ACCENT }}
          >
            Documento legal vigente
          </p>
          <h1
            className="max-w-4xl text-4xl font-semibold leading-tight sm:text-5xl lg:text-6xl"
            style={{ color: ACCENT }}
          >
            Política de Privacidad
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-8 text-slate-300 sm:text-lg">
            Una política clara sobre cómo Sira GPT recopila, utiliza, protege y
            comparte datos personales al operar una plataforma de inteligencia
            artificial multi-modelo.
          </p>

          <div className="mt-7 flex flex-wrap gap-3 text-sm text-slate-300">
            <span className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2">
              Última actualización: {UPDATED_AT}
            </span>
            <span className="rounded-md border border-[#FF0000]/40 bg-[#FF0000]/10 px-3 py-2 text-white">
              Versión 1.1.0
            </span>
          </div>
        </motion.header>

        <section aria-labelledby="summary-title" className="mb-12">
          <h2 id="summary-title" className="sr-only">
            Principios de privacidad
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PRINCIPLES.map((principle) => {
              const Icon = principle.icon;
              return (
                <div
                  key={principle.title}
                  className="rounded-lg border border-white/10 bg-white/[0.04] p-5"
                >
                  <Icon className="mb-4 h-5 w-5 text-[#FF0000]" aria-hidden="true" />
                  <h3 className="text-base font-semibold text-white">
                    {principle.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    {principle.text}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <div className="grid gap-10 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <div className="sticky top-8 rounded-lg border border-white/10 bg-white/[0.04] p-4">
              <p className="mb-4 text-sm font-semibold text-white">Contenido</p>
              <nav aria-label="Secciones de la política" className="space-y-1">
                {SECTIONS.map((section) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className="block rounded-md px-3 py-2 text-sm leading-5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white"
                  >
                    {section.title.replace(/^\d+\.\s*/, "")}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          <main className="space-y-4">
            {SECTIONS.map((section, index) => {
              const Icon = section.icon;
              return (
                <motion.section
                  key={section.id}
                  id={section.id}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-80px" }}
                  transition={{ duration: 0.35, delay: Math.min(index * 0.03, 0.18) }}
                  className="scroll-mt-24 rounded-lg border border-white/10 bg-white/[0.035] p-6 sm:p-8"
                >
                  <div className="mb-5 flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#FF0000]/30 bg-[#FF0000]/10">
                      <Icon className="h-4 w-4 text-[#FF0000]" aria-hidden="true" />
                    </div>
                    <h2 className="text-xl font-semibold leading-8 text-white sm:text-2xl">
                      {section.title}
                    </h2>
                  </div>
                  <div className="space-y-4 text-[15px] leading-8 text-slate-300 sm:text-base">
                    {section.body}
                  </div>
                </motion.section>
              );
            })}
          </main>
        </div>
      </div>
    </div>
  );
};

export default PrivacyPolicyPage;
