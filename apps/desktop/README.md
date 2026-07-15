# SiraGPT Desktop

Electron client for the hosted SiraGPT app on macOS and Windows. It opens the
authenticated chat directly and provides a native application menu, guarded
navigation, single-instance deep links, persisted window bounds, update checks,
and an offline recovery screen.

## Commands

```bash
npm run desktop:dev
npm run desktop:pack
npm run desktop:pack:mac
npm run desktop:pack:win
npm run desktop:dist:mac
npm run desktop:dist:win
```

By default the app opens `https://siragpt.com`. For local validation:

```bash
SIRAGPT_DESKTOP_URL=http://127.0.0.1:3000 npm run desktop:dev
```

Windows package commands target x64 so builds from Apple Silicon do not accidentally produce ARM-only Windows output.

macOS distribution produces separate Apple Silicon (`arm64`) and Intel (`x64`)
DMG/ZIP artifacts. Deep links use the `siragpt://` protocol and only route to an
explicit allowlist of SiraGPT screens.

Credentials, Apple Developer certificates, Windows signing certificates, and store accounts must stay outside Git.
