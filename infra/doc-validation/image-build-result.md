# Imagen candidata del validador — evidencia de componentes

Verificada en Lenovo el 2026-09-05 UTC. **No desplegada. No acredita gVisor ni
ediciones realizadas por Anthropic.** Solo documentos sintéticos y contenedores
de test, sin red, secretos, socket Docker ni montajes de producción en el validador.

## Identidades verificadas

| Elemento | Identidad |
|---|---|
| Ubuntu 24.04, manifest auditado | `sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517` |
| Imagen candidata del validador | `sha256:1a2be5c74d0291ffb120dbb5d8adb9689672858a181946adb7082c3398c4becc` |
| Dependencias Node de la imagen existente, solo para tests | `sha256:0efa5d4f999ae8493821248e37cd7745cc439a292fb4c13385905ae5e5d3f5da` |
| Ejecutable oficial Node 22 Debian, linux/amd64, solo para tests | `node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96` |
| Imagen auxiliar de tests corregida, glibc | `sha256:40f438311ab39713e617fc96b6dcbf5bdc62bf5141ddca954f739386da64176e` |

La imagen del validador tiene USER 65532:65532. La auxiliar usa 1000:1000 para
probar, entre otras cosas, que esa identidad no puede afirmar preflight aislado.
El launcher de producción sigue exigiendo `runsc`: no se sustituyó por runc.

## Herramientas e inventarios

`preflight_tools()` ejecutó Writer, Calc e Impress, comprobó sus PDF con qpdf,
extrajo el texto y abrió los PNG renderizados. Se ejecutó en la imagen candidata
sin red, solo lectura, UID 65532, capacidades retiradas y sin nuevos privilegios.
Límites: 1 CPU, 1 GiB, 256 PIDs, tmpfs privado 256 MiB y timeout 180 s.

| Evidencia | SHA-256 |
|---|---|
| `/opt/validator/os-packages.lock` | `2ae03fc2766cc3ec88ba20ecd03e26e0daa92add458a9c81a32284350b08d70b` |
| `/opt/validator/python-packages.lock` | `80283975a9fc63781c205ef92d1dd8e15a215e9e78acf2affeae8f01b8210694` |
| `fc-list`, 43 entradas ordenadas y unidas por LF sin LF final | `d3b79a4d63ad4fcd149bd7a69c0d0f658d3defcd90a4639b27ddbe8502b638c9` |
| PNG Writer del preflight | `0e17150a2816e6c6a2f4166dc49d73158bf8db5ceb8d7b8e815c38f86f02ade1` |
| PNG Calc del preflight | `1bbb570c6d89bcb92b573e8e1eef7673481f680bd58a5ce77453488d1420cfbb` |
| PNG Impress del preflight | `333db0de72ccce27aedcab3aa36133da1455c077893080c6d5b73f99f635b2db` |

Los archivos lock completos permanecen dentro de la imagen inmutable; estos
hashes identifican esa ejecución, no prometen el mismo render en otra plataforma.

## Pruebas ejecutadas

- `doc-sandbox-validation.test.py`: **42/42**, 21.484 s, exit 0, sin skips.
- `doc-sandbox-readiness.test.py`: **2/2**, 4.427 s, exit 0.
- `doc-sandbox-complex.fixture.test.cjs`, `doc-sandbox-complex.oracle.test.cjs`
  y `doc-sandbox-conservative-result.test.cjs`: **16/16**, 18112.078452 ms,
  exit 0, sin skips. G10 compara copias byte a byte, valida las cuatro capas,
  conserva cada PDF y rechaza salidas modificadas/incompletas. Son pruebas de
  componentes reales, no un job completo del proveedor.
- Generación y `fixtures/verify-docs.py`: **11/11**, 6.676 s, exit 0. Word con
  runs mixtos, header/footer/footnotes; Excel con fórmulas, recálculo y gráfico;
  PowerPoint con ocho diapositivas y notas; PDF con formulario/fuente embebida.

Todos los contenedores usan `--rm`, `--network none`, `--read-only`,
`--cap-drop ALL`, `--security-opt no-new-privileges`, 1 CPU, 1 GiB, 256 PIDs y
tmpfs `/tmp` privado. Solo ejecutan código revisado y fixtures sintéticos.
El entrypoint de la imagen auxiliar impone 600 s; ningún test usó un perfil
privilegiado, secretos productivos o un mock del validador.

## Fallos y recuperación

1. La primera descarga APT falló por `Hash Sum mismatch`. Se mantuvieron
   comprobaciones de firma, fecha y hash; `Acquire::By-Hash=force` y
   `APT::Update::Error-Mode=any` permitieron construir la candidata verificando
   íntegramente los índices y paquetes. No se aceptó la descarga corrupta.
2. El primer ejecutable de Node provenía de Alpine y requería musl, ausente en
   Ubuntu. La prueba falló con exit 127, antes de ejecutar casos. La imagen de
   test ahora toma el binario glibc oficial por digest y ejecuta `node --version`
   durante el build. El validador de producción no incorpora Node.
3. SSH se cortó al desempaquetar la imagen auxiliar corregida. No se asumió
   éxito: la reconexión verificó su ID y ejecutó las suites anteriores con éxito.

Las imágenes candidatas quedan conservadas para la validación posterior; no se
publicó ninguna aplicación. `runscRegistered=false` continúa bloqueando el flujo
de aceptación aislado. La fase sigue abierta según el
[informe parcial](../../docs/specs/doc-sandbox/reporte-fase-1.md).
