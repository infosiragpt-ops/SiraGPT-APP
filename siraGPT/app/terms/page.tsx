"use client"
import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';

const SECTIONS = [
  {
    title: '1. Aceptación de los términos',
    body: (
      <>
        Estos Términos del Servicio (los &quot;Términos&quot;) regulan el uso
        de Sira GPT en{' '}
        <a href="https://siragpt.com" className="text-indigo-300 underline">
          siragpt.com
        </a>{' '}
        (el &quot;Servicio&quot;). Al crear una cuenta, iniciar sesión o usar
        cualquier funcionalidad del Servicio aceptas estos Términos. Si no
        estás de acuerdo, no uses el Servicio.
      </>
    ),
  },
  {
    title: '2. Descripción del Servicio',
    body: (
      <>
        Sira GPT es una plataforma que te permite interactuar con varios
        modelos de inteligencia artificial de terceros (incluyendo, entre
        otros, los de OpenAI, Google, Anthropic, DeepSeek y OpenRouter) a
        través de una interfaz unificada. El Servicio puede incluir
        funcionalidades adicionales como generación de imágenes, análisis de
        documentos, integraciones opcionales y suscripciones de pago.
      </>
    ),
  },
  {
    title: '3. Cuenta y elegibilidad',
    body: (
      <>
        Para usar el Servicio debes tener al menos 18 años (o la mayoría de
        edad legal en tu jurisdicción) y proporcionar información veraz al
        registrarte. Eres responsable de mantener la confidencialidad de tu
        contraseña y de toda actividad realizada desde tu cuenta. Notifícanos
        de inmediato cualquier uso no autorizado escribiendo a{' '}
        <a href="mailto:infosiragpt@gmail.com" className="text-indigo-300 underline">
          infosiragpt@gmail.com
        </a>
        .
      </>
    ),
  },
  {
    title: '4. Uso aceptable',
    body: (
      <>
        Te comprometes a no usar el Servicio para:
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>
            Generar o distribuir contenido ilegal, difamatorio, fraudulento,
            que infrinja derechos de terceros, contenido sexual con menores,
            instrucciones para fabricar armas o cualquier material que viole
            la ley aplicable.
          </li>
          <li>
            Acosar, intimidar, suplantar identidades o causar daño a otras
            personas.
          </li>
          <li>
            Intentar vulnerar la seguridad del Servicio, eludir límites de uso,
            extraer datos masivamente (scraping), realizar ingeniería inversa
            de los modelos o de la plataforma, o interrumpir su
            funcionamiento.
          </li>
          <li>
            Usar el Servicio para entrenar modelos competidores o revender el
            acceso a terceros sin nuestra autorización por escrito.
          </li>
          <li>
            Generar contenido que viole las políticas de uso de los proveedores
            de modelos de IA (OpenAI, Google, Anthropic, etc.).
          </li>
        </ul>
        Podemos suspender o cancelar tu cuenta sin previo aviso si detectamos
        un uso indebido.
      </>
    ),
  },
  {
    title: '5. Contenido del usuario',
    body: (
      <>
        Conservas todos los derechos sobre el contenido que envías al Servicio
        (tus mensajes, archivos, prompts y resultados generados). Al usar el
        Servicio nos otorgas una licencia limitada, mundial, no exclusiva y
        revocable para procesar ese contenido con el único propósito de
        prestarte el Servicio (lo que incluye enviarlo al proveedor de IA que
        elijas para generar la respuesta). No usamos tu contenido para
        entrenar modelos sin tu consentimiento expreso.
      </>
    ),
  },
  {
    title: '6. Contenido generado por IA',
    body: (
      <>
        Las respuestas generadas por los modelos de IA pueden contener errores,
        información desactualizada o resultados inadecuados. Debes verificar y
        validar el contenido antes de usarlo en decisiones importantes. No
        ofrecemos asesoramiento legal, médico, financiero o profesional.
        Eres el único responsable del uso que hagas del contenido generado.
      </>
    ),
  },
  {
    title: '7. Suscripciones, pagos y reembolsos',
    body: (
      <>
        Algunas funcionalidades pueden requerir una suscripción de pago. Los
        precios, planes y límites se muestran en la página de planes. Las
        suscripciones se renuevan automáticamente al final de cada periodo
        salvo que las canceles antes del próximo cargo. Salvo que la ley
        aplicable exija lo contrario, los pagos no son reembolsables.
      </>
    ),
  },
  {
    title: '8. Cambios al Servicio',
    body: (
      <>
        Podemos modificar, suspender o discontinuar el Servicio (o parte de
        él) en cualquier momento. Haremos esfuerzos razonables para
        notificarte cambios sustanciales con antelación. Si discontinuamos el
        Servicio, te daremos un plazo razonable para exportar tus datos.
      </>
    ),
  },
  {
    title: '9. Propiedad intelectual',
    body: (
      <>
        El Servicio, su diseño, código, marcas y logotipos son propiedad de
        Sira GPT y están protegidos por las leyes aplicables. No se te otorga
        ninguna licencia sobre ellos más allá del derecho de uso del Servicio
        de acuerdo con estos Términos.
      </>
    ),
  },
  {
    title: '10. Limitación de responsabilidad',
    body: (
      <>
        El Servicio se presta &quot;tal cual&quot; y &quot;según
        disponibilidad&quot;, sin garantías de ningún tipo, explícitas o
        implícitas, dentro de los límites permitidos por la ley. En la máxima
        medida permitida por la ley aplicable, Sira GPT no será responsable
        por daños indirectos, incidentales, especiales, consecuentes o
        punitivos, ni por lucro cesante, pérdida de datos o pérdida de
        oportunidad de negocio derivados del uso o la imposibilidad de uso
        del Servicio.
      </>
    ),
  },
  {
    title: '11. Indemnización',
    body: (
      <>
        Aceptas indemnizar y mantener indemne a Sira GPT frente a cualquier
        reclamación, daño, pérdida o gasto (incluidos honorarios razonables
        de abogados) derivado de tu incumplimiento de estos Términos o del
        uso indebido del Servicio.
      </>
    ),
  },
  {
    title: '12. Cancelación de cuenta',
    body: (
      <>
        Puedes cerrar tu cuenta en cualquier momento desde la configuración o
        escribiéndonos. Podemos suspender o cancelar tu cuenta si incumples
        estos Términos, si el uso de tu cuenta supone un riesgo para
        terceros, o por orden de una autoridad competente.
      </>
    ),
  },
  {
    title: '13. Privacidad',
    body: (
      <>
        El tratamiento de tus datos personales se describe en nuestra{' '}
        <Link href="/privacy" className="text-indigo-300 underline">
          Política de Privacidad
        </Link>
        , que forma parte integral de estos Términos.
      </>
    ),
  },
  {
    title: '14. Ley aplicable y resolución de conflictos',
    body: (
      <>
        Estos Términos se rigen por las leyes aplicables al lugar de
        constitución de Sira GPT. Cualquier disputa derivada del Servicio se
        resolverá preferentemente de buena fe; en caso de no llegar a acuerdo,
        las partes se someten a los tribunales competentes del domicilio del
        prestador, salvo que la ley imperativa del consumidor disponga otra
        cosa.
      </>
    ),
  },
  {
    title: '15. Cambios a los Términos',
    body: (
      <>
        Podemos actualizar estos Términos para reflejar cambios en el Servicio
        o en la normativa. Publicaremos la nueva versión en esta página con
        una nueva fecha de &quot;Última actualización&quot;. Si continúas
        usando el Servicio tras la actualización, aceptas los nuevos
        Términos.
      </>
    ),
  },
  {
    title: '16. Contacto',
    body: (
      <>
        Para cualquier pregunta sobre estos Términos escríbenos a{' '}
        <a href="mailto:infosiragpt@gmail.com" className="text-indigo-300 underline">
          infosiragpt@gmail.com
        </a>
        .
      </>
    ),
  },
];

const TermsPage = () => {
  return (
    <div className="min-h-screen bg-gradient-to-b from-black to-gray-950 text-white">
      <div className="container mx-auto px-6 py-24">
        <motion.div
          initial={{ opacity: 0, y: -50 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
            Términos del Servicio
          </h1>
          <p className="text-lg text-gray-400 mt-4">
            Última actualización: 20 de mayo de 2026
          </p>
        </motion.div>

        <div className="max-w-4xl mx-auto bg-gray-900/50 border border-white/10 p-8 rounded-lg backdrop-blur-sm">
          <div className="space-y-8">
            {SECTIONS.map((s) => (
              <section key={s.title}>
                <h2 className="text-2xl font-semibold text-gray-200 mb-4">
                  {s.title}
                </h2>
                <div className="text-gray-400 leading-relaxed">{s.body}</div>
              </section>
            ))}

            <div className="pt-6 border-t border-white/10 text-sm text-gray-500">
              ¿Buscas la{' '}
              <Link href="/privacy" className="text-indigo-300 underline">
                Política de Privacidad
              </Link>
              ?
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TermsPage;
