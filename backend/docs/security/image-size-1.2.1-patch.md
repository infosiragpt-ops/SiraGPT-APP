# image-size 1.2.1: parche local verificable

## Alcance y procedencia

Este parche corrige los bucles sin progreso de los parsers ICNS y cajas BMFF
compartidas por HEIF/JPEG XL en las copias instaladas de `image-size@1.2.1`.
Conserva la versión, API, licencia MIT y soporte de formatos. No es una nueva
versión publicada por upstream, ni una eliminación de los avisos de npm.

Avisos revisados el 5 de septiembre de 2026:

- [GHSA-w3rx-r6r6-pgpr / CVE-2025-71330](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr): bucle ICNS.
- [GHSA-5p2g-fcmc-qvqq / CVE-2025-71329](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq): bucles JPEG XL/HEIF.
- [Informe técnico del investigador](https://joshua.hu/image-size-infinite-loop-dos-vulnerabilities).
- [Metadatos oficiales de image-size 1.2.1](https://registry.npmjs.org/image-size/1.2.1).

Los avisos no identificaban una versión corregida. La entrada publicada de
PptxGenJS 4.0.1 revisada no importa `image-size` en su código ejecutable; la
dependencia declarada por sí sola no demuestra que el flujo PPTX actual alcance
el parser vulnerable. Se parchea igualmente el paquete instalado completo para
cubrir llamadas directas y futuros consumidores, sin depender de un guard en
un único punto de la aplicación.

El tarball oficial se comprobó contra la integridad de su registro:

```text
sha512-rH+46sQJ2dlwfjfhCyNx5thzrv+dtmBIhPHk0zgRUukHzZ/kRueTJXoYYsclBaKcSMBWuGbOFXtioLpzTb5euw==
```

## Cambios mínimos

1. `readBox` comprueba que existe una cabecera completa, que el desplazamiento
   es válido y que cada caja devuelta avanza al menos ocho bytes. El tamaño
   BMFF cero, que significa hasta el final del archivo, se convierte al tamaño
   restante positivo; no se deshabilita HEIF ni JPEG XL. Las cajas extendidas
   de tamaño uno no estaban soportadas por este parser y se rechazan.
2. `readImageHeader` exige cabeceras ICNS completas y tamaños de entrada de al
   menos ocho bytes, contenidos en la longitud declarada. Cada iteración
   avanza. Permite leer una cabecera cuyo cuerpo excede el prefijo disponible,
   conservando la lectura limitada a 512 KiB de la API de archivos original.

El resto del paquete y su licencia permanecen intactos. Estas correcciones no
son una auditoría general de los formatos ni garantizan que cualquier otro
parser de imágenes sea seguro ante todas las entradas posibles.

## Hashes SHA-256 fijados

| Archivo relativo al paquete | Original oficial | Parcheado |
| --- | --- | --- |
| `dist/types/utils.js` | `e9faf86abcc962a5fc2488a4c3c9d8dc915aa22a0dd6a7bad6556cd9a326c349` | `e0b7c528061ea4f84fcefa819d1a9bbfbc4bbd26b299377f77a57e4ad6681272` |
| `dist/types/icns.js` | `5e6a097fca237b0bb3b68a1be920e39a3846c0018d8917658b5ed88590a710e8` | `e21f991efefc1704fda39e5a65b746fbaaeeb69c9b942a1c3bdec581b032dfd3` |

## Instalación y prueba de presencia

Desde `backend`, sin añadir paquetes:

```sh
node scripts/image-size-security-patch.cjs
node scripts/image-size-security-patch.cjs --verify
node --test tests/image-size-security-patch.test.js
```

El primer comando es el `postinstall`. Resuelve `node_modules` respecto al
script, recorre todas las copias hoisted, anidadas y scoped, y valida versiones
y bytes de **todas** antes de escribir. Es idempotente. No permite escribir
mediante enlaces fuera del árbol aislado de dependencias ni del paquete.
Una versión, identidad o hash desconocidos, archivos faltantes o ausencia del
paquete fallan; no se aplica un parche aproximado a futuras versiones.

`--verify` no escribe: exige los hashes parcheados en cada copia y devuelve
JSON con `verified`, los dos avisos, rutas y hashes reales verificados. Una
instalación con `--ignore-scripts` requiere aplicar y verificar explícitamente
el parche antes de construir/publicar. Docker debe copiar el script antes del
paso de instalación y verificarlo después de cualquier reinstalación de
dependencias, incluso la destinada a runtime.

`npm audit` seguirá mostrando la versión original como afectada. El gate de
publicación sólo puede reconocer estos dos avisos cuando la verificación del
árbol instalado ha pasado; **no** debe usar una excepción ciega por nombre de
paquete ni ignorar futuros avisos o hashes nuevos. Conservar el JSON de audit
original junto a la evidencia del parche. Un reporte audit limpio no sustituye
esta verificación y la verificación no debe borrar el reporte original.

## Pruebas reales, sin proveedores ni producción

`backend/tests/image-size-security-patch.test.js` restaura bytes oficiales por
hash dentro de un directorio temporal, aun cuando postinstall ya se ejecutó.
Los dos casos históricos se ejecutan en hijos separados con heap acotado,
watchdog de 100 ms iniciado **después** de cargar el parser y espera de salida
tras `SIGKILL`. Nunca se ejecuta el parser sin parche con esas entradas en el
proceso del servidor ni en el proceso principal de pruebas.

- ICNS de 16 bytes: el original no termina; el parche lanza `TypeError`.
- JPEG XL con `jxlp` de tamaño cero, menor de 100 bytes: el original no termina;
  el parche interpreta correctamente hasta EOF y devuelve dimensiones 8×8.
- PNG, JPEG, WebP, GIF, TIFF y AVIF reales codificados por Sharp: resultados
  originales y parcheados idénticos; dimensiones 17×23 comprobadas.
- Cabeceras válidas ICNS, HEIF/HEIC/AVIF y JXL completo/parcial: dimensiones y
  campos originales preservados, incluyendo ICNS con cuerpo grande y cajas
  BMFF válidas hasta EOF. No son una prueba de renderizado de esos fixtures.
- Entradas truncadas, tamaños insuficientes/excesivos, instalaciones múltiples,
  deriva de código/versión/manifest y symlinks: terminación o fallo cerrado.

No se afirma haber reproducido un bloqueo HEIF en 1.2.1: el caso reproducido de
la familia BMFF es JPEG XL; ambos usan la función compartida corregida.

Para retirar este parche se requiere una versión upstream que resuelva ambos
avisos, revisión del cambio, actualización explícita de pins/gate y repetir
las regresiones. No actualizar automáticamente los hashes para obtener verde.
