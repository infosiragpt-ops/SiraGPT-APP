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
- macOS notarization requires Hardened Runtime entitlements; these are configured in `apps/desktop/assets/entitlements.mac.plist`.
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
npm run native:version:check
npm run native:version:sync
npm run native:readiness:mobile
```

Release requirements:

- Android release builds require `android/keystore.properties` and the upload keystore in `android/keystores/`; both are intentionally ignored.
- Android `versionCode` and iOS `CURRENT_PROJECT_VERSION` are synced from `package.json` by `npm run native:version:sync`.
- Google Play publishing requires owner verification in Play Console.
- iOS release builds require full Xcode, Apple Developer signing, a matching provisioning profile, App Store Connect access, and manual review metadata.

## GitHub Actions

Use `Native desktop builds` in GitHub Actions to produce desktop artifacts on the correct operating systems:

- `siragpt-desktop-macos`: macOS `.dmg` and `.zip`.
- `siragpt-desktop-windows-x64`: Windows installer/portable `.exe`.

Use `Native mobile builds` in GitHub Actions to validate the Capacitor wrappers and produce QA artifacts:

- `siragpt-mobile-android`: Android debug `.apk` and release `.aab`.
- `siragpt-mobile-ios-simulator`: unsigned iOS simulator `.app` for wrapper validation.

These workflows are unsigned by default. Add signing credentials only through GitHub Actions secrets when distribution signing is ready.

### Latest Verified Native Builds

Latest native package SHA verified: `3eec62c1ba14313d5f04017ccff75685b6ebb17b` on `production-main`.

- Desktop workflow: `Native desktop builds` run `28722835938`.
  - macOS DMG + ZIP: passed.
  - Windows x64 NSIS + portable: passed.
  - Artifacts: `siragpt-desktop-macos`, `siragpt-desktop-windows-x64`.
- Mobile workflow: `Native mobile builds` run `28722835932`.
  - Android APK + AAB: passed.
  - iOS simulator build: passed.
  - Artifacts: `siragpt-mobile-android`, `siragpt-mobile-ios-simulator`.
- Readiness workflow: `Native readiness report` run `28722835962`.
  - Non-secret release plan and store packet generation: passed.

Unsigned QA packages from these runs are attached to the GitHub prerelease
`native-qa-v0.4.3-3eec62c`:

https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-qa-v0.4.3-3eec62c

The prerelease above is the latest durable public QA download packet. The
verified SHA also has fresh 14-day GitHub Actions artifacts attached to the
desktop and mobile runs listed above. These artifacts prove the wrappers and
unsigned QA packages build successfully for macOS, Windows, Android, and iOS
simulator. Public distribution still requires signing and store credentials.

Use `Native signed release packages` manually when real distribution credentials are configured. It can build one platform or all platforms:

- Android: signed Play upload `.aab`.
- iOS: signed App Store Connect `.ipa`.
- macOS: signed and notarized `.dmg` and `.zip`.
- Windows: signed `.exe` installer/portable artifacts.

The workflow can optionally create or update a GitHub Release with the built native artifacts. It runs a cheap `Signed release preflight` job first and intentionally fails before launching platform runners if the required signing secrets for the selected platform are missing.

The preflight validates package-signing credentials only:

- `android`: Android upload keystore secrets.
- `ios`: iOS signing certificate and provisioning profile.
- `macos`: Developer ID signing and notarization secrets.
- `windows`: Windows code-signing certificate secrets.
- `all`: all four package-signing groups above.

App Store Connect upload credentials are still listed below because they are required for store submission automation, but the current signed package workflow does not upload binaries to App Store Connect.

### Required GitHub Secrets For Signed Distribution

Run the local readiness check before attempting a signed release:

```bash
npm run native:readiness
npm run native:readiness:android
npm run native:readiness:ios
npm run native:readiness:mobile
npm run native:readiness:desktop
npm run native:readiness:all
npm run native:github-secrets:audit
npm run native:github-secrets:check
npm run native:release:plan
```

For focused CI/preflight output, use `npm run native:readiness -- --require=android,ios,macos,windows --only-required`.
For GitHub repository secret-name auditing, use `npm run native:github-secrets:audit -- --repo=infosiragpt-ops/SiraGPT-APP`.
For a non-secret management packet with missing GitHub secret names, owner
account actions, and safe upload commands, use:

```bash
npm run native:release:plan -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-release-plan.md --json-out=output/native-release-plan.json
```

GitHub Actions also exposes `Native readiness report`, which generates and
uploads the same non-secret Markdown/JSON packet as the artifact
`siragpt-native-readiness-report`. That workflow inspects secret presence from
GitHub Actions environment injection and never prints secret values.

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

App Store Connect upload secrets:

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
Normal account or mailbox passwords are not signing material and must not be
stored in GitHub Actions. Apple notarization requires an app-specific password,
and Google Play/iOS submission should use store-console credentials, API keys,
certificates, provisioning profiles, and upload keys created for app
distribution.
The GitHub secret audit prints only names and missing groups; it does not read
or print secret values.

### Running A Signed Native Release

1. Add the required secrets in GitHub: `Settings -> Secrets and variables -> Actions`.
2. Open `Actions -> Native signed release packages -> Run workflow`.
3. Choose `platform`:
   - `android` when only the Play `.aab` is needed.
   - `ios` when only the signed `.ipa` is needed.
   - `macos` when only the notarized desktop package is needed.
   - `windows` when only the Windows installer is needed.
   - `all` for the complete native release set.
4. Set `release_tag`, for example `native-v0.4.3`.
5. Enable `create_github_release` only when the artifacts should be attached to a public GitHub Release.

The workflow prints only secret names and readiness states. It must not print secret values.

Store publication requires account-level work outside Git:

- Apple Developer/App Store Connect access for iPhone distribution.
- Google Play Console access, owner verification, and a protected upload key for Android.
- A Developer ID certificate for macOS distribution outside the App Store.
- A Windows code-signing certificate for trusted Windows installers.

## Store Submission Packet

Non-secret store metadata and privacy declaration drafts live in
`docs/store-submission/`. Validate that this packet still matches the native
package IDs before submitting anything to a store:

```bash
npm run native:store:readiness
npm run native:store:assets:generate
npm run native:store:assets
npm run native:store:packet
```

These checks intentionally validate public metadata and public store-listing
assets only. They do not read or print signing credentials. The asset check
reports missing screenshots and listing graphics without failing by default;
use `npm run native:store:assets -- --require-ready` for final release gates.
Regenerate the screenshots with `native:store:assets:generate` whenever the
public product positioning or visible native store copy changes.
Use `native:store:packet` to create the non-secret platform folders that can be
used while filling Google Play, App Store Connect, macOS distribution, and
Windows distribution forms.

## Validation Checklist

Before pushing native release changes:

```bash
node -c apps/desktop/main.cjs
node -c scripts/generate-native-store-assets.js
node -c scripts/generate-native-store-packet.js
node -c scripts/native-store-assets-readiness.js
node -c scripts/native-store-readiness.js
sh -n scripts/build-desktop.sh
npm run native:version:check
npm run native:store:readiness
npm run native:store:assets:generate
npm run native:store:assets
npm run native:store:packet -- --require-ready
npm run desktop:pack
npm run desktop:pack:win
npm run mobile:sync
npm run mobile:doctor
npm run native:readiness
npm run native:readiness:desktop
npm run native:release:plan -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-release-plan.md --json-out=output/native-release-plan.json
npm run native:release:plan:ci
cd android && ./gradlew :app:assembleDebug :app:bundleRelease --no-daemon
bash scripts/check-secrets.sh
git diff --check
```
