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
            imágenes y proyectos que envías a la plataforma para que el modelo de
            IA los procese y te devuelva una respuesta.
          </li>
          <li>
            <strong>Datos técnicos:</strong> dirección IP, tipo de navegador,
            sistema operativo, fechas de acceso y registros de actividad, usados
            para seguridad, prevención de abuso y diagnóstico.
          </li>
          <li>
            <strong>Datos de facturación (si suscribes un plan):</strong>{' '}
            procesados por nuestro proveedor de pagos (no almacenamos tu número
            de tarjeta).
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
            <strong>Modelos de IA:</strong> OpenAI, Google (Gemini), Anthropic,
            DeepSeek, OpenRouter y otros del catálogo, para procesar el contenido
            que tú envías al modelo que elijas.
          </li>
          <li>
            <strong>Infraestructura:</strong> Replit (alojamiento y despliegue),
            Prisma / PostgreSQL (base de datos), Upstash Redis (caché y colas).
          </li>
          <li>
            <strong>Autenticación:</strong> Google OAuth (sólo si usas
            &quot;Continuar con Google&quot;).
          </li>
        </ul>
        Cada proveedor opera bajo su propia política de privacidad y aplica
        medidas técnicas y organizativas para proteger tus datos.
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
    title: '7. Conservación',
    body: (
      <>
        Conservamos tus datos mientras mantengas tu cuenta activa. Puedes
        eliminar tu cuenta en cualquier momento desde la configuración o
        escribiendo a{' '}
        <a href="mailto:infosiragpt@gmail.com" className="text-indigo-300 underline">
          infosiragpt@gmail.com
        </a>
        . Tras la eliminación, borramos tus datos en un plazo razonable salvo
        cuando una ley nos obligue a conservarlos (por ejemplo, registros de
        facturación).
      </>
    ),
  },
  {
    title: '8. Tus derechos',
    body: (
      <>
        Tienes derecho a acceder, rectificar, suprimir, oponerte al tratamiento,
        limitar el tratamiento y solicitar la portabilidad de tus datos
        personales. Para ejercerlos escríbenos a{' '}
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
    title: '9. Seguridad',
    body: (
      <>
        Aplicamos medidas técnicas y organizativas razonables para proteger tus
        datos: cifrado en tránsito (HTTPS/TLS), tokens de sesión firmados,
        cifrado de credenciales sensibles, controles de acceso, registros de
        auditoría y monitoreo de seguridad. Ningún sistema en internet es 100 %
        infalible, pero trabajamos continuamente para mitigar riesgos.
      </>
    ),
  },
  {
    title: '10. Cookies',
    body: (
      <>
        Usamos cookies estrictamente necesarias para mantener tu sesión y
        proteger contra ataques CSRF. No usamos cookies de publicidad de
        terceros.
      </>
    ),
  },
  {
    title: '11. Cambios a esta política',
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
    title: '12. Contacto',
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
