# SiraGPT Desktop

Electron shell for the hosted SiraGPT app on macOS and Windows.

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

Credentials, Apple Developer certificates, Windows signing certificates, and store accounts must stay outside Git.
