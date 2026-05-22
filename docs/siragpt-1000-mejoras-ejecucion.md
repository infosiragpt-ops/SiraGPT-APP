# Ejecucion profesional de las 1000 mejoras internas

Este documento convierte `docs/siragpt-1000-mejoras-internas.md` en un plan ejecutable. La regla operativa es simple: ninguna mejora se marca como completada si no tiene cambio concreto, prueba o verificacion asociada.

## Reglas de ejecucion

- Ejecutar por lotes pequenos y verificables, no como un cambio masivo sin control.
- Mantener la interfaz estable salvo que el cambio pida UI explicitamente.
- Priorizar seguridad, autenticacion, estabilidad de runtime, observabilidad y pruebas.
- Validar con `npm run type-check` y pruebas focalizadas antes de cerrar cada lote.
- Documentar cada lote con alcance, archivos tocados, verificacion y riesgos pendientes.

## Lote 1: autenticacion local segura

- Estado: implementado y validado.
- Mejora cubierta: boundary interno para autenticacion local de demo.
- Cambio: se extrajo la logica de credenciales demo locales a `lib/auth/local-demo-auth.ts`.
- Control: el acceso demo solo se habilita en hosts locales (`localhost`, `127.0.0.1`, IPv6 local y dominios `.local`).
- Control: el login demo no se activa implicitamente en ejecucion server-side.
- Pruebas: se agrego `tests/auth/local-demo-auth.test.ts` para hostnames, normalizacion y rechazo en produccion.
- Verificacion: `npm run type-check`, prueba focalizada y smoke local de login en `/chat`.

## Lote 2: persistencia y limpieza de sesion

- Estado: implementado y validado.
- Mejora cubierta: persistencia de sesion con metadatos internos sin duplicar tokens.
- Cambio: se agrego `lib/auth/session-storage.ts` para lectura, escritura, expiracion y limpieza atomica.
- Control: el token demo local expira a las 12 horas y se limpia junto con su metadata.
- Control: metadata corrupta o desalineada se elimina sin romper compatibilidad con tokens existentes.
- Pruebas: se agrego `tests/auth/session-storage.test.ts` para expiracion, limpieza, fallback sin storage y fingerprints.
- Verificacion: `npm run type-check`, `npm test` y smoke local de login.

## Lote 3: errores de login y recuperacion segura

- Estado: implementado y validado.
- Mejora cubierta: clasificacion segura de errores de autenticacion.
- Cambio: se agrego `lib/auth/auth-error-classifier.ts` para mapear estados sin reflejar texto no confiable.
- Control: `/auth/login?error=...` ya no muestra contenido arbitrario de la URL.
- Control: `/auth/callback` redirige con codigos seguros (`oauth_failed`, `expired_session`).
- Control: los logs de auth registran codigos clasificados en vez de objetos de error completos.
- Pruebas: se agrego `tests/auth/auth-error-classifier.test.ts` para codigos, redirecciones legacy y mensajes seguros.
- Verificacion: `npm run type-check`, `npm test` y smoke local de login con error query sanitizado.

## Lotes siguientes

- Lote 4: cubrir flujos criticos de chat con pruebas unitarias y smoke tests locales.
- Lote 5: centralizar contratos de API y normalizacion de errores.
- Lote 6: mejorar timeouts, cancelacion y reintentos controlados en cliente HTTP.
- Lote 7: instrumentar trazas y logs sin imprimir datos sensibles.
- Lote 8: reforzar limites de payload y sanitizacion de entradas.
- Lote 9: reducir acoplamiento entre frontend, auth, billing y chat.
- Lote 10: preparar gates de despliegue para impedir releases sin verificacion verde.

## Criterios de cierre por lote

- El cambio es pequeno y reversible.
- El codigo queda tipado sin errores nuevos.
- Hay prueba nueva o verificacion manual reproducible.
- No se introducen secretos, credenciales reales ni logs sensibles.
- La documentacion refleja lo hecho y lo pendiente.
