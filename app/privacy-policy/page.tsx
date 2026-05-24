"use client"
import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';

const SECTIONS = [
  {
    title: '1. Introducción',
    body: (
      <>
        En Sira GPT respetamos tu privacidad y tratamos tus datos personales con
        transparencia. Esta Política de Privacidad explica qué datos recopilamos,
        para qué los usamos, con quién los compartimos y qué derechos tienes
        sobre ellos. Al usar Sira GPT en{' '}
        <a href="https://siragpt.com" className="text-indigo-300 underline">
          siragpt.com
        </a>{' '}
        aceptas las prácticas descritas en este documento.
      </>
    ),
  },
  {
    title: '2. Responsable del tratamiento',
    body: (
      <>
        El responsable del tratamiento de tus datos es Sira GPT. Para cualquier
        consulta sobre privacidad puedes contactarnos en{' '}
        <a href="mailto:infosiragpt@gmail.com" className="text-indigo-300 underline">
          infosiragpt@gmail.com
        </a>
        .
      </>
    ),
  },
  {
    title: '3. Datos que recopilamos',
    body: (
      <>
        Recopilamos los datos mínimos necesarios para prestar el servicio:
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>
            <strong>Cuenta:</strong> nombre, correo electrónico y, si te registras
            con Google, tu identificador y foto pública de perfil.
          </li>
          <li>
            <strong>Contenido del usuario:</strong> los mensajes, archivos,
            imágenes, audios y proyectos que envías a la plataforma para que el
            modelo de IA los procese y te devuelva una respuesta. Esto incluye
            el contenido pegado o arrastrado al chat, los documentos cargados a
            la biblioteca y las instrucciones que defines en tus GPTs y
            proyectos.
          </li>
          <li>
            <strong>Datos derivados:</strong> índices vectoriales, embeddings y
            extractos generados a partir de tus documentos para permitir la
            búsqueda semántica, la memoria del proyecto y el análisis
            documental. Estos derivados se eliminan junto con el contenido
            original cuando borras el documento.
          </li>
          <li>
            <strong>Datos técnicos:</strong> dirección IP, tipo de navegador,
            sistema operativo, fechas de acceso, huella de sesión y registros
            de actividad, usados para seguridad, prevención de abuso y
            diagnóstico. Las IPs se enmascaran en la interfaz de gestión de
            sesiones.
          </li>
          <li>
            <strong>Datos de uso y créditos:</strong> contador de llamadas al
            modelo, tokens consumidos, plan activo y consumo de las
            herramientas (búsqueda web, generación de imagen/video, voz). Se
            usan para aplicar los límites del plan y mostrar tu consumo en
            facturación.
          </li>
          <li>
            <strong>Datos de facturación (si suscribes un plan):</strong>{' '}
            procesados por nuestros proveedores de pagos (Stripe / Mercado
            Pago). Nunca almacenamos tu número de tarjeta completo — sólo el
            identificador del cliente y los últimos 4 dígitos cuando el
            proveedor los devuelve.
          </li>
        </ul>
      </>
    ),
  },
  {
    title: '4. Para qué usamos tus datos',
    body: (
      <>
        Tratamos tus datos para:
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>Crear y mantener tu cuenta y permitirte iniciar sesión.</li>
          <li>Procesar tus conversaciones con los modelos de IA del catálogo.</li>
          <li>
            Facturar y gestionar tu suscripción si tienes un plan de pago.
          </li>
          <li>
            Garantizar la seguridad del servicio, detectar fraudes y abusos, y
            cumplir obligaciones legales.
          </li>
          <li>
            Mejorar la calidad del servicio (analíticas agregadas y anónimas).
          </li>
        </ul>
      </>
    ),
  },
  {
    title: '5. Proveedores que procesan tus datos',
    body: (
      <>
        Para prestar el servicio compartimos datos estrictamente necesarios con
        proveedores que actúan como encargados del tratamiento:
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>
            <strong>Modelos de IA:</strong> OpenAI, Google (Gemini), Anthropic
            (Claude), xAI (Grok), DeepSeek, OpenRouter y los modelos
            open-source del catálogo (incluyendo Gemma3). El contenido que
            envías al modelo que elijas se transmite al proveedor
            correspondiente sólo para esa solicitud.
          </li>
          <li>
            <strong>Búsqueda y verificación:</strong> Tavily, Exa, Firecrawl,
            SearXNG (búsqueda web), CrossRef, arXiv, OpenAlex, PubMed,
            Semantic Scholar (verificación científica para el generador de
            tesis y la verificación de citas).
          </li>
          <li>
            <strong>Voz y multimedia:</strong> ElevenLabs (síntesis y
            transcripción de voz), proveedores de generación de imagen/video
            según el modelo activado.
          </li>
          <li>
            <strong>Pagos:</strong> Stripe, Mercado Pago (procesamiento de
            tarjetas y suscripciones; no almacenamos el PAN completo).
          </li>
          <li>
            <strong>Infraestructura:</strong> VPS dedicado (alojamiento y
            despliegue), PostgreSQL (base de datos), Redis (caché, colas
            BullMQ, rate limiting), almacenamiento de archivos compatible con
            S3.
          </li>
          <li>
            <strong>Observabilidad:</strong> Sentry, OpenTelemetry, PostHog
            (errores, telemetría agregada y analítica de producto). Las
            cargas útiles enviadas se sanitizan para eliminar tokens,
            contraseñas y PII detectable.
          </li>
          <li>
            <strong>Autenticación:</strong> Google OAuth (sólo si usas
            &quot;Continuar con Google&quot;).
          </li>
        </ul>
        Cada proveedor opera bajo su propia política de privacidad y aplica
        medidas técnicas y organizativas para proteger tus datos. Mantenemos
        contratos de encargo de tratamiento (DPA) con cada uno.
      </>
    ),
  },
  {
    title: '6. Inicio de sesión con Google',
    body: (
      <>
        Cuando eliges &quot;Continuar con Google&quot; solicitamos únicamente los
        permisos <strong>perfil básico y correo electrónico</strong>. No leemos,
        enviamos ni modificamos tus correos, calendarios ni archivos. Las
        integraciones avanzadas con Gmail, Calendar o Drive son opcionales y se
        activan por separado desde tu cuenta — sólo entonces te pedimos
        permisos específicos para esos servicios.
      </>
    ),
  },
  {
    title: '7. Archivos cargados y biblioteca',
    body: (
      <>
        Los archivos que cargas en chats, proyectos, GPTs y la biblioteca se
        almacenan asociados a tu cuenta. Se procesan para extraer texto,
        generar vistas previas y construir índices que habilitan la búsqueda
        semántica y el análisis documental. Sólo el usuario propietario (y
        las personas con quienes lo comparta explícitamente, en proyectos o
        GPTs visibles para su equipo) pueden acceder a ellos. Cuando eliminas
        un archivo, eliminamos también sus derivados (chunks, embeddings,
        vistas previas) en un plazo máximo de 30 días.
      </>
    ),
  },
  {
    title: '8. Conectores opcionales (Gmail, Drive, Calendar, GitHub, etc.)',
    body: (
      <>
        Los conectores con servicios externos (Gmail, Google Drive, Google
        Calendar, GitHub, Slack, Notion, Canva, Figma, WhatsApp y otros del
        catálogo) son <strong>opcionales</strong> y se activan uno por uno
        desde la configuración. Cuando los activas:
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>
            Te mostramos exactamente qué permisos OAuth solicitamos antes de
            que apruebes la conexión.
          </li>
          <li>
            Sólo usamos esos permisos para las funciones que tú invocas
            (enviar un correo, leer un documento que tú nos pides analizar,
            etc.).
          </li>
          <li>
            No leemos tus correos, calendarios o archivos por nuestra cuenta
            ni los usamos para entrenamiento.
          </li>
          <li>
            Puedes revocar el acceso en cualquier momento desde la
            configuración (Aplicaciones) y, adicionalmente, desde la consola
            de seguridad del proveedor correspondiente.
          </li>
        </ul>
      </>
    ),
  },
  {
    title: '9. Conservación y eliminación',
    body: (
      <>
        Conservamos tus datos mientras mantengas tu cuenta activa.
        Puedes eliminar tu cuenta en cualquier momento desde la configuración
        (sección Cuenta) o escribiendo a{' '}
        <a href="mailto:infosiragpt@gmail.com" className="text-indigo-300 underline">
          infosiragpt@gmail.com
        </a>
        . Plazos típicos tras la eliminación:
        <ul className="list-disc pl-6 mt-3 space-y-2">
          <li>
            <strong>Cuenta y contenido (chats, archivos, biblioteca,
            proyectos, GPTs):</strong> eliminación lógica inmediata y borrado
            físico en un plazo máximo de 30 días.
          </li>
          <li>
            <strong>Registros de auditoría:</strong> retenidos hasta 36 meses
            para cumplir obligaciones de seguridad y prevención de fraude.
          </li>
          <li>
            <strong>Facturas y registros fiscales:</strong> conservados según
            la normativa local aplicable (típicamente 5 a 10 años).
          </li>
          <li>
            <strong>Copias de seguridad:</strong> los respaldos rotativos se
            sobrescriben en un plazo máximo de 90 días.
          </li>
        </ul>
      </>
    ),
  },
  {
    title: '10. Tus derechos',
    body: (
      <>
        Tienes derecho a acceder, rectificar, suprimir, oponerte al tratamiento,
        limitar el tratamiento y solicitar la portabilidad de tus datos
        personales. También puedes exportar tus chats, archivos y biblioteca
        desde la sección Control de datos de la configuración. Para ejercer
        derechos que no estén disponibles en la interfaz, escríbenos a{' '}
        <a href="mailto:infosiragpt@gmail.com" className="text-indigo-300 underline">
          infosiragpt@gmail.com
        </a>
        . Si consideras que no atendimos correctamente tu solicitud, puedes
        presentar una reclamación ante tu autoridad de protección de datos
        competente.
      </>
    ),
  },
  {
    title: '11. Seguridad',
    body: (
      <>
        Aplicamos medidas técnicas y organizativas razonables para proteger tus
        datos: cifrado en tránsito (HTTPS/TLS), tokens de sesión firmados (JWT
        validados contra la base de datos en cada solicitud), 2FA opcional
        (TOTP) y WebAuthn / passkeys, cifrado de credenciales sensibles en
        reposo, encabezados de seguridad (Helmet, CSP), CORS por entorno,
        protección CSRF, rate limiting en endpoints sensibles, validación de
        entrada con Zod, fingerprint de sesión que auto-revoca tokens
        sospechosos, etiquetado de fuentes verificadas/sin verificar en las
        respuestas con búsqueda web, y registros de auditoría con retención
        controlada. Ningún sistema en internet es 100 % infalible, pero
        trabajamos continuamente para mitigar riesgos.
      </>
    ),
  },
  {
    title: '12. Cookies',
    body: (
      <>
        Usamos cookies estrictamente necesarias para mantener tu sesión y
        proteger contra ataques CSRF. No usamos cookies de publicidad de
        terceros ni rastreo cross-site.
      </>
    ),
  },
  {
    title: '13. Transferencias internacionales',
    body: (
      <>
        Algunos de nuestros proveedores (modelos de IA, infraestructura,
        observabilidad) procesan datos en servidores ubicados fuera de tu país
        de residencia, incluyendo Estados Unidos y la Unión Europea. Para esas
        transferencias nos apoyamos en las cláusulas contractuales tipo
        publicadas por la Comisión Europea y, cuando aplica, en los marcos de
        adecuación reconocidos. Mantenemos contratos de encargo de tratamiento
        (DPA) con cada proveedor que recibe datos personales.
      </>
    ),
  },
  {
    title: '14. Decisiones automatizadas y entrenamiento',
    body: (
      <>
        Sira GPT no toma decisiones automatizadas con efectos jurídicos o
        significativos sobre ti. Los modelos de IA generan respuestas a tus
        peticiones, pero no perfilamos automáticamente a las personas ni
        usamos esos perfiles para decisiones de crédito, contratación,
        seguros o similares. <strong>No entrenamos modelos propios con el
        contenido de tus chats, archivos o biblioteca.</strong> El contenido
        que envías al modelo que elijas se transmite al proveedor sólo para
        responder esa solicitud; consulta su política para conocer su uso de
        prompts y respuestas (la mayoría ofrece opción de no entrenamiento
        que mantenemos activada por defecto).
      </>
    ),
  },
  {
    title: '15. Menores de edad',
    body: (
      <>
        Sira GPT no está dirigido a personas menores de 13 años (o la edad
        mínima aplicable en tu jurisdicción). No recopilamos a sabiendas
        datos personales de menores. Si eres padre, madre o tutor y crees que
        un menor a tu cargo nos ha proporcionado datos, escríbenos a{' '}
        <a href="mailto:infosiragpt@gmail.com" className="text-indigo-300 underline">
          infosiragpt@gmail.com
        </a>{' '}
        y procederemos a eliminarlos.
      </>
    ),
  },
  {
    title: '16. Cambios a esta política',
    body: (
      <>
        Podemos actualizar esta Política de Privacidad para reflejar cambios en
        el servicio o en la normativa aplicable. Te notificaremos los cambios
        relevantes mediante el sitio o por correo electrónico. La fecha al pie
        indica la versión vigente.
      </>
    ),
  },
  {
    title: '17. Contacto',
    body: (
      <>
        Para cualquier pregunta sobre esta política o el tratamiento de tus
        datos personales escríbenos a{' '}
        <a href="mailto:infosiragpt@gmail.com" className="text-indigo-300 underline">
          infosiragpt@gmail.com
        </a>
        .
      </>
    ),
  },
];

const PrivacyPolicyPage = () => {
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
            Política de Privacidad
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
              ¿Buscas los{' '}
              <Link href="/terms" className="text-indigo-300 underline">
                Términos del Servicio
              </Link>
              ?
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PrivacyPolicyPage;
