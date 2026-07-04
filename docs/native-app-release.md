# SiraGPT Native App Release

This document tracks the native wrappers for the hosted SiraGPT product.

## Desktop

The desktop shell is an Electron app in `apps/desktop`. It opens the production app at `https://siragpt.com` by default and allows local validation with `SIRAGPT_DESKTOP_URL`.

Commands:

```bash
npm run desktop:dev
npm run desktop:pack
npm run desktop:pack:mac
npm run desktop:pack:win
npm run desktop:dist:mac
npm run desktop:dist:win
```

Notes:

- macOS builds target Apple Silicon from Apple Silicon hosts unless a different architecture is requested.
- Windows builds are pinned to x64 so local builds from Apple Silicon create the expected Windows package.
- Release installers require external signing credentials:
  - Apple Developer ID certificate for macOS distribution outside the App Store.
  - Windows code-signing certificate for SmartScreen trust.
- Signing certificates, passwords, and store account credentials must stay outside Git.

## iOS And Android

The mobile shell uses Capacitor with bundle ID `com.siragpt.app`, app name `Sira GPT`, and production URL `https://siragpt.com`.

Commands:

```bash
npm run mobile:sync
npm run mobile:doctor
npm run mobile:open:ios
npm run mobile:open:android
npm run mobile:release:android
```

Release requirements:

- Android release builds require `android/keystore.properties` and the upload keystore in `android/keystores/`; both are intentionally ignored.
- Google Play publishing requires owner verification in Play Console.
- iOS release builds require full Xcode, Apple Developer signing, App Store Connect access, and manual review metadata.

## GitHub Actions

Use `Native desktop builds` in GitHub Actions to produce desktop artifacts on the correct operating systems:

- `siragpt-desktop-macos`: macOS `.dmg` and `.zip`.
- `siragpt-desktop-windows-x64`: Windows installer/portable `.exe`.

The workflow is unsigned by default. Add signing credentials only through GitHub Actions secrets when distribution signing is ready.

## Validation Checklist

Before pushing native release changes:

```bash
node -c apps/desktop/main.cjs
sh -n scripts/build-desktop.sh
npm run desktop:pack
npm run desktop:pack:win
npm run mobile:sync
npm run mobile:doctor
bash scripts/check-secrets.sh
git diff --check
```
