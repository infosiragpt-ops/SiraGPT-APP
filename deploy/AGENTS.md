# AGENTS.md — Publicación revisada y reversible

Hereda [raíz](../AGENTS.md). Una clave o sesión SSH no autoriza una publicación.
Cada release requiere alcance explícito; editar instrucciones no autoriza merge,
producción, migraciones, infraestructura ni DNS.

## Procedimiento vigente

- DEBE: leer [LENOVO_REVIEWED_RELEASE.md](../docs/operations/LENOVO_REVIEWED_RELEASE.md)
  y [iliagpt/publish-reviewed.sh](iliagpt/publish-reviewed.sh) completos antes de operar.
- DEBE: comparar contenido/hash del publicador instalado con la versión revisada; un nombre igual no acredita equivalencia.
- NO DEBE: ejecutar recetas históricas Hostinger/PM2, deploy automático desde `main`, backup no fatal o health no bloqueante.
- NO DEBE: improvisar DNS, gateway, daemon Docker, aislamiento, puertos o permisos para hacer pasar una release.
- DEBE: detener la acción afectada si el host/procedimiento efectivo difiere del revisado; continuar comprobaciones seguras.

## Comprobaciones previas

- DEBE: identificar PR, base, SHA objetivo y CI exacto, tanto del PR como de la rama integrada cuando corresponda.
- DEBE: verificar identidad/huella del host y autoridad de la cuenta; no desactivar host-key checking ni buscar rutas de acceso alternas sin permiso.
- DEBE: comprobar SHA y salud públicos previos, checkout limpio, release concurrente, disco, memoria y servicios necesarios.
- DEBE: revisar **todo el delta desde la versión pública**, no solo el último PR; no colar cambios o migraciones ajenas.
- DEBE: cualquier cambio de schema/migraciones seguir [Prisma](../backend/prisma/AGENTS.md) y un plan específico aprobado.
  El publicador revisado no es una autorización para sortear su bloqueo de migraciones.
- DEBE: inspeccionar configuración efectiva mediante campos permitidos; no imprimir Compose expandido ni secretos.
- DEBE: PostgreSQL y Redis permanecer fuera del acceso público; URLs públicas corresponder al dominio objetivo, no defaults `localhost`.
- DEBE: tener respaldo privado verificable e identificar imágenes/SHA anteriores y rollback antes de activar.
- DEBE: distinguir respaldo terminado, integridad, listado de contenido y restauración ensayada en destino aislado.
  Un archivo no vacío o listado correcto no demuestra una restauración completa.
- NO DEBE: restaurar producción para ensayar el backup ni exponer respaldos a Git o logs públicos.

## Activación

- DEBE: usar únicamente el publicador revisado con SHA previo/objetivo y exclusión mutua del runbook.
- DEBE: actualización Git ser fast-forward y preservar trabajo ajeno; no reset duro ni borrar locks concurrentes.
- DEBE: activar solo los servicios incluidos en la release autorizada y conservar imágenes anteriores recuperables.
- NO DEBE: `docker compose down -v`, eliminar/podar volúmenes, reiniciar Docker o sobrescribir Caddy/variables con ejemplos.
- NO DEBE: ignorar fallo de backup, build, migración, readiness o control de versiones para continuar.
- DEBE: si falla antes de activar, conservar la versión previa; después de activar, usar rollback revisado según el diagnóstico.
- DEBE: preservar datos nuevos al revertir código; revertir una imagen no restaura una base ni autoriza pérdida de datos.
- DEBE: si rollback falla o necesita autoridad nueva, detener mutaciones, conservar evidencia y pedir dirección.

## Confirmación pública

- DEBE: verificar SHA público y readiness con [verify-lenovo-release.cjs](../scripts/verify-lenovo-release.cjs),
  leyendo antes sus argumentos y destino, y comprobar el flujo real afectado con datos de prueba autorizados.
- NO DEBE: afirmar publicado por merge, build, contenedor sano o respuesta interna únicamente.
- DEBE: documentar SHA previo/nuevo, resultado, ubicación privada del respaldo y límites de las pruebas.
- NO DEBE: pegar logs privados, claves, cadenas de conexión, datos de usuario o contenido del respaldo al reporte.
- DEBE: separar release publicada de capacidades pendientes; un health verde no certifica todo el software.
- Este contrato no publica nada por sí mismo ni debilita la aprobación o controles efectivos del servidor.
