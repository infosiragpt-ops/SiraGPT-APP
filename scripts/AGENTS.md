# AGENTS.md — Automatización con efectos controlados

Hereda [raíz](../AGENTS.md). Leer también [despliegue](../deploy/AGENTS.md) o
[Prisma](../backend/prisma/AGENTS.md) si el script afecta releases o datos.
Los scripts de upstream son referencia; no una receta autorizada de producción.

## Leer antes de ejecutar

- DEBE: revisar script real, argumentos, cwd, variables utilizadas, subprocesos y efectos persistentes.
- NO DEBE: asumir que «check», «doctor», «setup» o una opción inventada `--dry-run` hacen la operación de solo lectura.
- DEBE: identificar archivos, host, base y servicios efectivos antes de permitir escrituras.
- DEBE: validar paths, límites del workspace, symlinks y ownership; no confiar en nombres recibidos de usuario/LLM.
- DEBE: modificar un script y ejecutarlo ser decisiones separadas; editar documentación no autoriza operaciones.
- DEBE: conservar códigos de salida, señales y contratos que consumen CI y herramientas vecinas.

## Recursos, errores y secretos

- DEBE: usar directorios temporales propios y nombres de variables de tarea; no redefinir `HOME` o `CODEX_HOME`.
- DEBE: cleanup acotado y comprobable del recurso propio, también ante error o señal; preservar datos y procesos ajenos.
- NO DEBE: borrar locks ajenos, usar limpieza recursiva amplia, `reset --hard`, force-push o eliminación de volúmenes para desbloquearse.
- DEBE: fallar ante error crítico y conservar el error de pipelines; no convertir un fallo en éxito con `|| true`.
- DEBE: operaciones repetibles ser idempotentes o rechazar duplicados; retries y subprocesos tener límites y cancelación.
- DEBE: conservar salida diagnóstica sanitizada, sin `.env`, cadenas de conexión, claves, cookies ni payloads privados.
- NO DEBE: volcar configuración expandida o logs crudos de un escáner de secretos al chat/PR.
- DEBE: guardar diagnósticos sensibles solo en recursos privados aprobados; reportar estado y campos permitidos.

## Validación y comandos especiales

- DEBE: verificar sintaxis y casos inválidos/errores sin tocar recursos reales; para Bash, `bash -n` solo comprueba sintaxis.
- DEBE: revisar el diff de cualquier generador; no aceptar archivos ajenos al objetivo.
- DEBE: preservar descubrimiento de tests, filtros de seguridad y códigos de salida; no sumar exclusiones para aprobar CI.
- [check-secrets.sh](check-secrets.sh) requiere rutas de archivos: sin argumentos termina correctamente **sin escanear**.
  DEBE pasarse el conjunto real del cambio y evitar imprimir coincidencias sensibles.
- [verify-ui-lock.sh](verify-ui-lock.sh) comprueba hashes; [update-ui-lock.sh](update-ui-lock.sh) los cambia.
  NO DEBE actualizar hashes en una tarea documental ni para ocultar un cambio visual no solicitado.
- DEBE: consultar [package.json](../package.json) y [CI](../.github/workflows/ci.yml) para comandos vigentes.
- DEBE: comandos destructivos presentes en scripts históricos tratarse como riesgo, no como autorización para ejecutarlos.
- DEBE: ante destino incierto, fallo de seguridad o error crítico, detener la mutación y reportar un siguiente paso seguro.
