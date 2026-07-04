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

Use `Native mobile builds` in GitHub Actions to validate the Capacitor wrappers and produce QA artifacts:

- `siragpt-mobile-android`: Android debug `.apk` and release `.aab`.
- `siragpt-mobile-ios-simulator`: unsigned iOS simulator `.app` for wrapper validation.

These workflows are unsigned by default. Add signing credentials only through GitHub Actions secrets when distribution signing is ready.

### Required GitHub Secrets For Signed Distribution

Run the local readiness check before attempting a signed release:

```bash
npm run native:readiness
npm run native:readiness:android
```

Android signing secrets:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded Play upload keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: upload key alias.
- `ANDROID_KEY_PASSWORD`: upload key password.

iOS/App Store Connect signing secrets:

- `APPLE_TEAM_ID`: Apple Developer team id.
- `IOS_SIGNING_CERTIFICATE_BASE64`: base64-encoded iOS signing certificate.
- `IOS_SIGNING_CERTIFICATE_PASSWORD`: signing certificate password.
- `IOS_PROVISIONING_PROFILE_BASE64`: base64-encoded provisioning profile.
- `APP_STORE_CONNECT_API_KEY_ID`: App Store Connect API key id.
- `APP_STORE_CONNECT_API_ISSUER_ID`: App Store Connect API issuer id.
- `APP_STORE_CONNECT_API_KEY_BASE64`: base64-encoded App Store Connect private key.

Desktop signing secrets:

- `MACOS_CERTIFICATE_BASE64`: base64-encoded Developer ID certificate.
- `MACOS_CERTIFICATE_PASSWORD`: macOS certificate password.
- `APPLE_ID`: Apple ID used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: Apple app-specific password for notarization.
- `WINDOWS_CERTIFICATE_BASE64`: base64-encoded Windows code-signing certificate.
- `WINDOWS_CERTIFICATE_PASSWORD`: Windows certificate password.

Never commit these values. Store them only as GitHub Actions secrets or in the vendor store portals.

Store publication requires account-level work outside Git:

- Apple Developer/App Store Connect access for iPhone distribution.
- Google Play Console access, owner verification, and a protected upload key for Android.
- A Developer ID certificate for macOS distribution outside the App Store.
- A Windows code-signing certificate for trusted Windows installers.

## Validation Checklist

Before pushing native release changes:

```bash
node -c apps/desktop/main.cjs
sh -n scripts/build-desktop.sh
npm run desktop:pack
npm run desktop:pack:win
npm run mobile:sync
npm run mobile:doctor
npm run native:readiness
cd android && ./gradlew :app:assembleDebug :app:bundleRelease --no-daemon
bash scripts/check-secrets.sh
git diff --check
```
