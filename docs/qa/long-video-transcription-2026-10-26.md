# Verificación de transcripción de videos largos — 26 de octubre de 2026

## Fallos corregidos

- Una consulta de estado de carga sin bytes nuevos reiniciaba el presupuesto de recuperación. Ahora solo el avance confirmado permite continuar los reintentos; las partes guardadas siguen disponibles.
- Regenerar el aviso de una entrega de transcripción lo borraba y enviaba los videos al chat general. Ahora actualiza la conversación conservando la entrega y los turnos posteriores.
- La entrega caducaba a las 24 horas aunque el trabajo siguiera activo o en cola. Ahora comprueba ambos carriles y conserva la entrega ante trabajo activo, reintentos o estado desconocido.
- Un decodificador podía emitir solo una parte de la pista y obtener cobertura completa sobre esas piezas. Ahora se verifica la duración conocida del audio seleccionado antes de reconocer voz.
- Las pausas de timestamps se comprimían al decodificar; se conservan como silencio. El nuevo reloj identifica sus checkpoints para no mezclarlos con cortes anteriores. La duración etiquetada de Matroska se normaliza respecto al inicio de la pista.

## Prueba de infraestructura con un archivo de diez horas

Se generó un MKV sintético real con video H.264 de 32 × 32 y audio FLAC: 36.000 segundos y 5.706.750 bytes. FFprobe confirmó la duración de ambas pistas. SHA-256 del archivo: `3bf8b5a13ae7b6f0586679844f682faae5f60fd4ff85d25bfb66aee2aa1b1d2f`.

Se ejecutaron FFmpeg y FFprobe 9.0.2, obtenidos del distribuidor Evermeet enlazado desde la página oficial de FFmpeg, con firmas OpenPGP verificadas. Las herramientas se instalaron únicamente en una carpeta temporal de pruebas; no cambiaron las dependencias del producto.

| Comprobación | Resultado observado |
| --- | --- |
| Decodificación y segmentación real | 60 archivos FLAC, suma de 36.000 segundos |
| Reloj de los nuevos cortes | `pts-v1`, offsets continuos |
| Segunda preparación | Reutilizó el manifiesto sin volver a ejecutar FFmpeg ni FFprobe |
| Interrupción | Después de guardar 20 resultados de reconocimiento simulados |
| Reanudación en otro proceso | Reutilizó esos 20 y procesó solamente los 40 restantes |
| Ensamblado | 60 segmentos, cobertura 1, sin marca parcial |
| Último timestamp de respuesta simulada | 35.999,078 segundos |
| Relectura de todos los checkpoints | Texto idéntico, sin nuevos cortes ni llamadas al doble de reconocimiento |

La segmentación tardó 16,4 segundos en el equipo de prueba y Node alcanzó unos 64 MiB de RSS durante esa fase. **No es una medición de velocidad de reconocimiento ni del servidor de producción.**

Además, una prueba real de FFmpeg generó audio de dos segundos con una pausa temporal de ocho segundos. Antes del cambio se reducía a dos segundos; ahora mantiene diez segundos. Se probaron pistas que comienzan después del video y etiquetas Matroska con inicio distinto de cero.

## Pruebas de regresión

- `backend/tests/audio-transcriber-completeness.test.js`: pista de diez horas, 60 piezas, piezas ausentes, redondeo, audio más corto que el video y pausa temporal real.
- `backend/tests/audio-transcriber-intake.test.js`: reconstrucción de caché incompleta y compatibilidad de pistas.
- `backend/tests/media-probe.test.js`: tiempos iniciales y duración de pistas, incluido archivo Matroska real.
- `backend/tests/media-transcription-queue.test.js`: estados de ambas colas, aislamiento por propietario, recuperación y fallo visible de audio incompleto.
- `backend/tests/media-delivery*.test.js`: entrega posterior a 24 horas sin duplicados y sin cerrar trabajo activo.
- `tests/lib/chunked-upload-resumable.test.ts`: recuperación con y sin bytes nuevos.
- `tests/lib/chat-turn-single-retry-path.test.tsx`: reintento del aviso, conservación de contexto y fallo de conexión.

Las regresiones nuevas se observaron fallando antes de aplicar sus correcciones. Las 13.676 pruebas generales del proyecto pasaron, así como TypeScript y lint (con advertencias existentes). Las suites de audio y sondeo ejecutaron 173 pruebas con FFmpeg real sin omisiones.

## Límites de la evidencia y del servicio

El archivo sintético contiene pantalla negra y silencio. **El reconocimiento de voz de la prueba de diez horas se simuló:** no mide exactitud lingüística ni acredita una conversación real de diez horas. Tampoco prueba una subida de 10 GB o una sesión autenticada en producción. Demuestra duración, decodificación, segmentación, persistencia, recuperación entre procesos y ensamblado temporal.

El límite existente es 10 GB por archivo; diez horas de video con bitrate alto pueden superarlo. El registro aportado muestra dos cargas terminadas y falta de saldo en un proveedor de transcripción, no un timeout por diez horas. Los cambios de código no recargan saldos externos. La validación de versión y salud de producción se realiza aparte, después del despliegue.
