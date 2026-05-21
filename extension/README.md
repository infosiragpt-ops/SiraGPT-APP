# Sira Appshots

Extensión de Chrome / Edge / Brave / Arc que captura cualquier ventana, pestaña
o pantalla y la envía a Sira como contexto de un chat nuevo.

## Instalación (modo desarrollador)

1. Abre `chrome://extensions` y activa el switch **Modo desarrollador**.
2. Pulsa **Cargar descomprimida** y elige esta carpeta (`extension/`).
3. Abre la extensión, pulsa **Vincular con Sira** y sigue las instrucciones.

## Vincular con tu cuenta

1. Inicia sesión en <https://siragpt.com>.
2. Ve a **Ajustes → Appshots** (`/settings/appshots`).
3. Pulsa **Generar código** y copia el token que aparece (sólo se muestra una vez).
4. En la extensión, pega el código en el campo **Código de vinculación** y guarda.

## Uso

- Atajo: `⌘⇧S` (Mac) o `Ctrl+Shift+S` (Win/Linux).
- O abre la extensión y pulsa **Capturar ahora**.
- Aparece el selector nativo de Chrome → elige una ventana, pestaña o pantalla.
- Sira abre un chat nuevo con la captura adjunta.

## Limitaciones conocidas

- El atajo sólo funciona cuando Chrome está enfocado (limitación del navegador).
  Para capturar sin tener que enfocar Chrome haría falta una app nativa de Mac.
- Las cookies y SameSite de la extensión usan el dominio configurado en
  **Opciones → Servidor de Sira**. Cambia la URL si pruebas contra otro entorno.
- Tamaño máximo de la captura: 10 MB (≈ 4K en PNG).

## Privacidad

- La captura viaja sólo entre la extensión y tu servidor de Sira por HTTPS.
- El token se guarda en `chrome.storage.local`, accesible únicamente a la
  extensión. Puedes revocarlo desde **Ajustes → Appshots → Sesiones**.

---

## QA manual punta-a-punta

Este guion cubre el flujo MV3 (service-worker → offscreen document →
`getUserMedia`) cargando la extensión sin empaquetar en un Chrome real. Está
pensado para repetirse antes de cada release de la extensión y al tocar
cualquier mensaje cruzado entre `background.js` y `offscreen.js`.

### Requisitos previos

- Chrome 116+ (necesario para `chrome.offscreen` estable) o Edge/Brave/Arc
  basado en una versión equivalente.
- Una cuenta en el entorno contra el que vas a probar (prod, staging o
  `localhost:3000`). Para entornos no-prod, ajusta el campo **Servidor de Sira**
  en las opciones de la extensión.
- DevTools abierto (`F12`) sobre `chrome://extensions` y el service worker de
  Sira Appshots desplegado (`Service worker → inspeccionar`) para ver logs y
  memoria durante el flujo.

### 1) Cargar la extensión y vincular

1. `chrome://extensions` → **Modo desarrollador** → **Cargar descomprimida** →
   elige `extension/`.
2. Verifica que aparece **Sira Appshots** con el id de la extensión visible y
   sin advertencias rojas.
3. Abre el popup → debe mostrar **"Sin vincular"** y ocultar el botón
   **Capturar ahora**. Pulsa **Vincular con Sira**: se abre `options.html` en
   una pestaña nueva.
4. En otra pestaña, inicia sesión en Sira, ve a `/settings/appshots`, pulsa
   **Generar código** y copia el token (formato `appshots_…`).
5. En las opciones de la extensión, pega el token, deja el servidor por defecto
   (o cámbialo al entorno de prueba), pulsa **Guardar**. El status debe
   ponerse en verde: *"Guardado. Ya puedes capturar con ⌘⇧S."*.
6. Reabre el popup → debe mostrar **"Vinculado con …"** y revelar el botón
   **Capturar ahora**.

### 2) Capturar una ventana

1. Pon en primer plano cualquier app que no sea Chrome (Finder, VS Code, etc.).
2. Vuelve a Chrome y pulsa el botón **Capturar ahora** en el popup.
3. Aparece el selector nativo de Chrome → pestaña **Ventana** → elige la app
   anterior → **Compartir**.
4. Esperado: el popup se cierra, Chrome abre una pestaña nueva en
   `${API_BASE}/chat?...` con un chat nuevo y la captura adjunta visible en el
   historial. Comprueba que la imagen no está en negro ni recortada a 0x0.

### 3) Capturar una pestaña

1. Repite el paso 2.2 pero esta vez en el selector elige **Pestaña de Chrome**
   y selecciona cualquier pestaña distinta de la del popup.
2. Esperado: mismo flujo, la captura debe contener el contenido renderizado de
   la pestaña elegida (no el chrome del navegador).

### 4) Capturar la pantalla completa

1. Repite el paso 2.2 y en el selector elige **Toda la pantalla** → elige el
   monitor → **Compartir**.
2. Esperado: la captura contiene el escritorio completo, incluida cualquier
   ventana en primer plano.

### 5) Atajo de teclado sin pasar por el popup

1. Cierra el popup si está abierto. Asegúrate de que Chrome tiene el foco pero
   ninguna otra ventana de la extensión está visible.
2. Pulsa `⌘⇧S` (Mac) o `Ctrl+Shift+S` (Win/Linux).
3. Esperado: aparece **directamente** el selector nativo de Chrome, sin que se
   abra el popup de la extensión. Cancela con **Esc** y verifica que no salta
   ninguna notificación de error (cancelación silenciosa esperada).
4. Repite, pero esta vez completa la captura y comprueba que el chat se abre
   igual que con el botón del popup.

> Si el atajo no dispara nada, abre `chrome://extensions/shortcuts` y
> confirma que **Capturar ventana y enviar a Sira** sigue mapeado a
> `⌘⇧S` / `Ctrl+Shift+S`. Algún otro plugin (1Password, capturas del SO) puede
> habérselo robado.

### 6) Sin fugas de memoria entre capturas

El service worker mantiene vivo el offscreen document mientras dura la captura.
Si un blob URL o un MediaStreamTrack quedan colgados, la heap del worker crece
de captura en captura.

1. `chrome://extensions` → **Sira Appshots** → **service worker → inspeccionar**.
2. En DevTools del worker → pestaña **Memory** → toma un **Heap snapshot**
   inicial (Snapshot 1).
3. Ejecuta **dos** capturas consecutivas completas (cualquiera de los modos
   anteriores). Espera a que ambos chats se abran.
4. Fuerza una GC desde la pestaña **Memory** (icono de papelera) y toma un
   nuevo snapshot (Snapshot 2).
5. Compara *Snapshot 2 → Comparison → Snapshot 1*: el delta de objetos `Blob`,
   `MediaStream` y `HTMLVideoElement` retenidos debe ser **0**. Si crece
   monótonamente captura a captura, es regresión del cleanup en
   `background.js::grabFrameViaOffscreen` o en `offscreen.js::grabFrame`.
6. En la pestaña **Application → Storage → IndexedDB / Blob URLs** comprueba
   que no quedan blob URLs vivos al terminar (`URL.revokeObjectURL` se invoca
   en ambos lados).

### 7) Cancelaciones y errores visibles

- Lanza una captura, pulsa **Esc** en el selector → el popup vuelve a estado
  normal sin notificación de error (cancelación esperada).
- Borra la vinculación desde **Opciones → Borrar vinculación**, intenta
  capturar → debe abrirse la página de opciones y mostrarse una notificación
  *"Falta vincular la extensión con Sira."*.
- Corrompe a propósito el servidor (URL inalcanzable) → la captura debe
  fallar con notificación clara *"Sira rechazó la captura (…)"* y dejar el
  popup operativo para reintentar.

### 8) Sign-off

Captura un resumen (texto plano) con: versión de Chrome, sistema operativo,
entorno (`apiBase`) y commit de la extensión probada. Pégalo en el PR junto
con cualquier desviación de los pasos anteriores.

## Tests automatizados

`e2e/extension-appshots.spec.ts` levanta Chromium con `--load-extension` y
verifica las partes del flujo que no dependen del selector nativo de captura
(no automatizable): registro del service worker, render del popup/options,
round-trip de `chrome.storage.local`, atajo declarado en el manifest. Cubrir
la captura real sigue requiriendo el QA manual de las secciones 2-6.

Ejecutar sólo este spec:

```bash
npx playwright test e2e/extension-appshots.spec.ts
```

El test se auto-omite si el entorno no puede ejecutar Chromium con extensiones
cargadas (por ejemplo, headless puro sin Xvfb).
