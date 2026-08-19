# SiraGPT Master Execution Prompt

Fecha de adopcion: 2026-05-23
Alcance: producto, arquitectura, seguridad, calidad, pruebas, documentacion y CI/CD.

Este documento convierte el prompt maestro de SiraGPT en una guia operativa
versionada para el equipo tecnico y los agentes de desarrollo. Su objetivo es
evitar improvisacion: cada cambio debe respetar la interfaz actual, mejorar el
funcionamiento interno y dejar evidencia verificable.

## Rol tecnico esperado

El trabajo sobre SiraGPT debe ejecutarse con criterio de arquitectura senior,
full stack, producto digital, seguridad de aplicaciones, experiencia de usuario,
bases de datos, automatizacion, agentes inteligentes, documentacion tecnica y
despliegue profesional.

La responsabilidad tecnica incluye analizar, planificar, disenar, implementar,
probar, documentar y optimizar el sistema con cambios pequenos, auditables y
reversibles.

## Objetivo del producto

SiraGPT debe consolidarse como una plataforma avanzada de inteligencia artificial
conversacional, productividad, investigacion, generacion de contenido,
programacion asistida, gestion de proyectos, busqueda web, multimedia,
automatizacion y administracion empresarial.

La meta no es copiar productos externos. La meta es alcanzar un estandar
competitivo con funcionalidades propias, arquitectura robusta, flujos
inteligentes, trazabilidad de datos, verificacion de informacion,
personalizacion avanzada, administracion de modelos, control de consumo,
gestion documental y tareas complejas organizadas.

## Principios no negociables

- Mantener la interfaz principal existente.
- No mover botones, menus, vistas, rutas ni modulos salvo correccion justificada.
- No eliminar funcionalidades existentes.
- No romper rutas actuales ni contratos publicos.
- No inventar datos, metricas, citas, DOI, autores, articulos, tesis,
  normativas ni referencias.
- No exponer claves, secretos, tokens ni margenes internos de ganancia.
- No prometer exactitud absoluta; separar informacion verificada, inferida y no
  confirmada.
- No prometer evasion de detectores academicos; promover escritura original,
  etica y correctamente citada.
- No mezclar contexto entre chats, proyectos, archivos o usuarios.
- No permitir acceso a modulos restringidos sin permisos.
- No desplegar a produccion sin validacion explicita.

## Politica de integridad de fuentes

SiraGPT debe tratar cualquier solicitud de fuentes reales, citas, APA 7, DOI,
tesis, normativa, datos actuales, precios, modelos disponibles o metricas como
trabajo que requiere trazabilidad. El sistema puede redactar borradores,
estructuras y explicaciones, pero no debe convertir informacion no verificada en
referencias, cifras o hechos confirmados.

Reglas operativas:

- Citar solo fuentes provistas por archivos del usuario, RAG, Web Search,
  conectores, proveedores academicos o fuentes pegadas explicitamente.
- No usar obras "parecidas", "canonicas" o plausibles como sustituto de una
  fuente verificada.
- Separar informacion verificada, inferida y no confirmada cuando la evidencia
  sea incompleta.
- En tesis y trabajos academicos, dejar referencias como pendientes de
  verificacion si no existen metadatos reales.
- Validar DOI, URL, titulo, proveedor, fecha y relacion entre afirmacion y
  fuente antes de presentar una bibliografia como final.
- Registrar limitaciones sin inventar autores, revistas, leyes, estadisticas ni
  metricas administrativas.

## Contexto tecnico base

- Carpeta local principal: `/Users/luis/Desktop/siraGPT`.
- Frontend: React / Next.js.
- Backend: Node.js / Express.
- Base de datos: PostgreSQL.
- ORM esperado o existente: Prisma, Drizzle o equivalente evaluado antes de
  migrar.
- Autenticacion: JWT con refresh tokens revocables.
- Password hashing: argon2 o bcrypt.
- Validacion: Zod, Joi, Yup o equivalente centralizado.
- Pruebas: node:test, Vitest, Jest, Supertest y Playwright segun el area.
- Seguridad HTTP: Helmet, CORS por entorno, rate limiting, sanitizacion y
  proteccion contra inyeccion, path traversal y subidas maliciosas.
- Observabilidad: logs estructurados, auditoria de acciones criticas,
  metricas y monitoreo de errores.
- Archivos: almacenamiento local controlado en desarrollo y S3-compatible en
  produccion cuando aplique.
- Procesos largos: colas, workers, BullMQ, Redis o sistema equivalente.

Si una tecnologia existente no coincide con este stack, no se reemplaza de
forma automatica. Primero se evalua compatibilidad, costo de migracion, impacto
en produccion y estabilidad.

## Flujo obligatorio por tarea

1. Analizar el requerimiento real del usuario.
2. Revisar codigo, documentacion, estado git y workflows relevantes.
3. Identificar dependencias, riesgos y archivos afectados.
4. Definir un plan breve con cambios minimos y seguros.
5. Implementar incrementalmente sin alterar la estructura visual principal.
6. Validar frontend, backend, seguridad, rendimiento y accesibilidad segun el
   alcance.
7. Ejecutar pruebas, lint, type-check y build cuando correspondan.
8. Corregir errores antes de entregar.
9. Documentar variables, migraciones, comandos y criterios de validacion.
10. Preparar commits claros.
11. Subir cambios solo cuando esten validados y no disparen despliegues no
    autorizados.
12. Verificar GitHub Actions y reportar el estado.

## Modulos funcionales a consolidar

- Usuarios, autenticacion, roles, permisos, sesiones y recuperacion de cuenta.
- Nuevo chat con conversaciones aisladas, archivos propios y estado limpio.
- Chats recientes con continuidad real y sin mezcla de contexto.
- Busqueda de chats textual y, cuando exista infraestructura, semantica.
- Biblioteca con archivos, carpetas, metadatos, permisos, trazabilidad e
  historial.
- GPTs personalizados con instrucciones, herramientas, documentos, versiones,
  visibilidad y metricas.
- Parafraseo etico: standard, humanize, formal, academic, simple, creative,
  expand, shorten y custom.
- Proyectos con memoria dedicada, archivos, conversaciones, tareas,
  colaboradores, permisos e historial.
- Diseno para piezas visuales, prototipos, diagramas, presentaciones,
  versiones y exportacion.
- Codex y agentes de programacion con analisis de repos, pruebas, commits,
  revision y coordinacion trazable.
- Barra de chat estable con autosize, pegado inteligente, archivos, imagenes,
  codigo, audios, herramientas, borradores y accesibilidad.
- Boton `+` para archivos, herramientas, documentos, imagenes, carpetas y
  contexto.
- Dictado y modo voz con permisos, transcripcion, pausa, correccion,
  cancelacion y estados claros.
- Tema claro, oscuro y sistema con persistencia por usuario.
- Selector de modelos con planes, creditos, favoritos, fallback y mensajes
  claros.
- Subida de archivos con validacion de tamano, extension, MIME, duplicados,
  permisos y seguridad.
- Web Search con deteccion temporal, fuentes oficiales, citas, enlaces y
  advertencias de incertidumbre.
- Video Studio, imagenes y video IA con colas, creditos, historial, estados y
  guardado en biblioteca.
- Generador de tesis con fuentes verificables, APA 7 cuando aplique y sin
  referencias inventadas.
- Planes, creditos, tokens, facturacion, pagos, limites y administracion.
- Perfil, configuracion, privacidad, seguridad, sesiones, modelos,
  notificaciones, conectores y control de datos.
- Panel administrativo con usuarios, modelos, conexiones, pagos, facturas,
  metricas, base de datos, seguridad, reportes, estado y ajustes.

## Seguridad minima exigida

- JWT de corta duracion y refresh tokens revocables.
- Passwords cifrados con argon2 o bcrypt.
- Validacion estricta en frontend y backend.
- Rutas privadas protegidas.
- RBAC y permisos por modulo.
- Rate limiting en login, registro, recuperacion y endpoints criticos.
- Proteccion contra XSS, CSRF cuando aplique, SQL/NoSQL injection, path
  traversal y archivos maliciosos.
- CORS configurado por entorno.
- Helmet y headers seguros.
- Auditoria de acciones sensibles.
- MFA opcional para usuarios y obligatorio para administradores cuando el modulo
  este activo.
- Manejo seguro de errores sin exponer detalles internos.
- Escaneo basico de dependencias y ausencia de secretos en git.

## Calidad y pruebas

Cada cambio debe tener una validacion proporcional al riesgo:

- Cambios de UI: preservar layout principal, verificar responsive y estados.
- Cambios de API: validar contratos, errores, permisos y pruebas de ruta.
- Cambios de auth/seguridad: pruebas obligatorias y revision de regresiones.
- Cambios de base de datos: migracion revisada, indices, relaciones,
  rollback/compatibilidad y datos existentes.
- Cambios de agentes/modelos: trazabilidad, limites, creditos, errores,
  fallback y auditoria.
- Cambios docs-only: `git diff --check` como minimo.

Comandos habituales, ajustados al alcance:

```bash
npm install
npm run lint
npm run type-check
npm test
npm run test:unit
npm run test:e2e
npm run build
```

## Entrega tecnica

Cada entrega debe reportar:

- Resumen de cambios.
- Archivos modificados.
- Arquitectura aplicada.
- Variables de entorno o migraciones si existen.
- Comandos para ejecutar localmente.
- Pruebas realizadas y resultado.
- Riesgos restantes.
- Estado de GitHub Actions si hubo push.

## Regla de despliegue

GitHub verde no significa produccion automatica. Los cambios pueden validarse en
CI sin desplegar. Produccion requiere decision explicita, pruebas minimas y un
workflow manual o un proceso aprobado.
