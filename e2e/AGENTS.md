# AGENTS.md — Evidencia de navegador y flujos completos

Hereda [raíz](../AGENTS.md) y [pruebas](../tests/AGENTS.md). Una prueba de interfaz
con API interceptada no acredita el backend ni el proveedor real.

## Preparación segura

- DEBE: leer [playwright.config.ts](../playwright.config.ts), spec y fixtures antes de lanzar el navegador.
- DEBE: comprobar URL, puerto, autenticación, webServer y servicios que cada prueba utiliza o modifica.
- NO DEBE: redirigir una suite mutante a producción o cuentas de clientes para conseguir un resultado.
- DEBE: usar servidores, recursos y documentos sintéticos aislados; no matar procesos ajenos ni compartir `.next` entre builds concurrentes.
- DEBE: las llamadas pagadas reales tener autorización y presupuesto; una clave disponible no basta.
- NO DEBE: subir cookies, storage state, credenciales o capturas con datos privados a Git o artefactos públicos.
- DEBE: distinguir el servicio que arrancó la prueba de uno preexistente; cleanup solo del propio.

## Qué debe comprobarse

- DEBE: recorrer la acción del usuario hasta su resultado persistido; cargar la página con HTTP 200 no basta.
- DEBE: cubrir botones, teclado, foco, Escape, selección y persistencia de los controles modificados.
- DEBE: comprobar viewport móvil/escritorio, tema y movimiento reducido cuando afecten el cambio.
- DEBE: conservar los controles y estados loading, disabled, error, cancelado y vacío que soporta el producto.
- DEBE: en documentos, descargar y verificar el archivo correcto, bytes, contenido, formato y edición posterior.
- NO DEBE: considerar una tarjeta «Validado», captura o respuesta sintética prueba de edición profesional real.
- DEBE: probar acceso denegado y pertenencia de recursos cuando se afecte autorización o descarga.
- DEBE: usar locators estables por rol/nombre/test ID; no coordenadas frágiles ni waits que encubran fallos.
- DEBE: esperar eventos/estados observables con plazo acotado, incluyendo finalización asíncrona y limpieza relevante.

## Regresiones y evidencia

- DEBE: conservar los casos negativos existentes; ajustar una expectativa requiere comportamiento autorizado.
- NO DEBE: ampliar retries, omitir un spec o regrabar snapshots para esconder una regresión.
- DEBE: revisar diferencias visuales individualmente y actualizar baseline solo para el diseño pedido.
- DEBE: registrar qué APIs fueron interceptadas, qué backend/proveedor fue real y qué quedó sin probar.
- DEBE: asociar resultados a commit, URL/entorno, navegador y comandos exactos, sin secretos.
- DEBE: registrar fallos y limitaciones; una suite parcial no se presenta como certificación de todo el software.
- Ejecutar desde raíz mediante los scripts de [package.json](../package.json); elegir proyectos/specs que realmente existan.
- Si el entorno requerido falta, mantener pendiente ese gate y continuar únicamente comprobaciones seguras independientes.
