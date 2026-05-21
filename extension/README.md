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
