# Evidencia del diagnóstico previo

Fecha: 2026-09-04. **No es un reporte de cierre de fase.** No se implementó el módulo ni se desplegó este cambio.

## Revisión y aislamiento del trabajo

- Base comprobada con `git log -1 --format='%H %s'`:

```text
0f24e4d004f156eae838e21592539cca91f53cd3 refactor(ai): harden generate observability (#559)
```

- Rama documental separada: `docs/doc-sandbox-plan`. El checkout de trabajo del usuario tenía modificaciones en cinco archivos de composer/CSS/tests; se preservaron sin editar, resetear ni mezclar.
- La especificación se leyó completa y se conservó en `SPEC-sandbox-edicion-documentos.md`. `diff -u` con el adjunto original mostró solo la adición de un salto de línea final; su contenido no fue corregido unilateralmente.
- Se inspeccionaron rutas/servicios/test runners reales y documentación oficial. La revisión de fuentes acredita lo que el código expresa; no acredita que esa ruta se esté usando en producción.

## Pruebas existentes ejecutadas

Comando, desde la raíz de este worktree:

```sh
NODE_ENV=test node --test --test-reporter=spec \
  backend/tests/doc-route-edit-no-regen.test.js \
  backend/tests/docx-list-preserving-edit.test.js \
  backend/tests/xlsx-surgical-edit.test.js \
  backend/tests/pptx-surgical-edit.test.js \
  backend/tests/pdf-surgical-edit.test.js
```

Salida real final del runner (resumen; se omiten las líneas individuales por caso por extensión):

```text
ℹ tests 53
ℹ suites 15
ℹ pass 53
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 486.2835
```

Exit code: **0**. Runtime local: Node `v26.7.0`; esto no sustituye ejecutar en la imagen del backend, que declara Node 22. El runner emitió una advertencia experimental de `localStorage` sin archivo configurado; no hubo casos fallidos por esa advertencia.

Alcance: rutas que rechazan regeneración, propiedades de listas/párrafos DOCX, operaciones quirúrgicas XLSX/PPTX/PDF y helpers existentes. Son pruebas offline; no se llamaron modelos, no hubo cuenta productiva ni worker/Redis/Postgres real en esta batería.

## Incidencia de preparación, resuelta sin cambiar código

La primera ejecución utilizó `NODE_PATH` para reutilizar dependencias ya disponibles. Resultado: 53 tests, 47 aprobados y 6 fallidos en `mime_type`. La comprobación directa de `import('file-type')` devolvió `ERR_MODULE_NOT_FOUND`: el import ESM no resolvió el paquete mediante `NODE_PATH`.

Se comparó el `backend/package-lock.json` con el de la instalación local reutilizada mediante `cmp` (exit 0) y se añadió un enlace `backend/node_modules` ignorado por Git hacia esa instalación. No se instalaron/actualizaron paquetes ni se editaron tests o validadores. Repetir el comando anterior produjo 53/53. Para reproducción limpia en otra máquina, instalar el lock con el procedimiento habitual en vez de depender de ese enlace local.

## Qué no se ha ejecutado ni se declara aprobado

- Golden G1–G12 nuevos con motor real; cobertura ≥80 % del futuro módulo.
- Upload/continuación/descarga/borrado real en Anthropic o medición de costo.
- Apertura en Word/Excel/PowerPoint, LibreOffice del worker, render visual ni comparación de una tesis real aportada por Luis.
- Nuevas tablas, autenticación de las rutas propuestas, SSE durable, reinicios, cancelación, retención o carga de diez jobs.
- Build/lint/type-check completos del producto durante este diagnóstico; CI de una fase; despliegue y canary productivo.

La conclusión verificable es que existe una base de edición reutilizable con 53 casos locales seleccionados en verde, **no** que la especificación ya esté implementada. El [plan de fases](01-plan-por-fases.md) define las pruebas faltantes y el permiso requerido para comenzar.
