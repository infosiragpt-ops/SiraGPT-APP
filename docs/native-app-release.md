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
- Google Play publishing requires owner verification in Play Console and a Google Play Android Publisher service account secret in GitHub Actions.
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

Latest native package SHA verified: `0fb0493464b841c11924e9ff9a087209fb8d25dd` on `production-main`.
Latest repository validation SHA: `1e657aaf40853df5a3f844b86028a17fae88cad0`
(`ci(native): automate store owner packet`).

- Desktop workflow: `Native desktop builds` run `28725624116`.
  - macOS DMG + ZIP: passed.
  - Windows x64 NSIS + portable: passed.
  - Artifacts: `siragpt-desktop-macos`, `siragpt-desktop-windows-x64`.
- Mobile workflow: `Native mobile builds` run `28725624118`.
  - Android APK + AAB: passed.
  - iOS simulator build: passed.
  - Artifacts: `siragpt-mobile-android`, `siragpt-mobile-ios-simulator`.
- Readiness workflow: `Native readiness report` run `28725476833`.
  - Non-secret release plan and store packet generation: passed.
- Current traceability workflow set on SHA `1e657aaf40853df5a3f844b86028a17fae88cad0`:
  - CI: `28727085654`.
  - Native readiness report with owner handoff artifact: `28727085668`.
  - Native mobile builds: `28727085656`.
  - Native desktop builds: `28727085653`.
  - Docker build images: `28727085650`.
- Signed release preflight: `Native signed release packages` run `28727578162`.
  - Input: `platform=all`, `release_tag=native-v0.4.3-signing-preflight`.
  - Result: intentionally stopped in preflight before Android, iOS, macOS, or Windows runners because signing secrets are not configured yet.
  - URL: `https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/28727578162`.

Unsigned QA packages from these runs are attached to the GitHub prerelease
`native-qa-v0.4.3-0fb0493`:

https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-qa-v0.4.3-0fb0493

The prerelease above is the latest durable public QA download packet. The
verified SHA also has fresh 14-day GitHub Actions artifacts attached to the
desktop and mobile runs listed above. These artifacts prove the wrappers and
unsigned QA packages build successfully for macOS, Windows, Android, and iOS
simulator. The prerelease includes `native-release-manifest.json`,
`native-release-manifest.md`, and `SHA256SUMS.txt` so every QA artifact can be
verified against its SHA-256 checksum. Public distribution still requires
signing and store credentials.

Use `Native signed release packages` manually when real distribution credentials are configured. It can build one platform or all platforms:

- Android: signed Play upload `.aab`.
- iOS: signed App Store Connect `.ipa`.
- macOS: signed and notarized `.dmg` and `.zip`.
- Windows: signed `.exe` installer/portable artifacts.

The workflow can optionally create or update a GitHub Release with the built native artifacts. When `create_github_release` is enabled, it also publishes `native-release-manifest.json`, `native-release-manifest.md`, and `SHA256SUMS.txt` so every native installer can be audited by version, Git SHA, platform, size, and SHA-256 checksum. It can also upload the signed Android `.aab` to Google Play when `upload_android_google_play` is enabled and upload the signed iOS `.ipa` to App Store Connect when `upload_ios_app_store_connect` is enabled. It runs a cheap `Signed release preflight` job first and intentionally fails before launching platform runners if the required signing or upload secrets for the selected operation are missing.

The preflight validates package-signing credentials by default:

- `android`: Android upload keystore secrets.
- `ios`: iOS signing certificate and provisioning profile.
- `macos`: Developer ID signing and notarization secrets.
- `windows`: Windows code-signing certificate secrets.
- `all`: all four package-signing groups above.

When `upload_ios_app_store_connect` is enabled for `platform=ios` or
`platform=all`, the preflight also requires the `appstore` upload secret group
before any macOS runner starts.

When `upload_android_google_play` is enabled for `platform=android` or
`platform=all`, the preflight also requires the `googleplay` upload secret group
before the Android runner starts. The workflow defaults to the Google Play
internal testing track `qa` with release status `draft`; use
`android_release_status=inProgress` only with `android_user_fraction`, and use
`completed` only when the release should go live on the chosen track.

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
npm run native:github-secrets:setup -- --platform=all --dry-run
npm run native:release:plan
```

For focused CI/preflight output, use `npm run native:readiness -- --require=android,ios,macos,windows --only-required`.
For GitHub repository secret-name auditing, use `npm run native:github-secrets:audit -- --repo=infosiragpt-ops/SiraGPT-APP`.
To audit all required native signing groups while printing only required
statuses, use
`npm run native:github-secrets:audit -- --repo=infosiragpt-ops/SiraGPT-APP --only-required`.
For a non-secret management packet with missing GitHub secret names, owner
account actions, and safe upload commands, use:

```bash
npm run native:release:plan -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-release-plan.md --json-out=output/native-release-plan.json
```

GitHub Actions also exposes `Native readiness report`, which generates and
uploads the same non-secret Markdown/JSON packet as the artifact
`siragpt-native-readiness-report`. That workflow inspects secret presence from
GitHub Actions environment injection and never prints secret values.

To upload signing secrets from a trusted local machine without printing values,
use the setup helper. It accepts existing base64 environment variables or
raw file paths for keystores, certificates, provisioning profiles, and API key
files:

```bash
npm run native:github-secrets:setup -- --platform=all --dry-run
npm run native:github-secrets:setup -- --platform=android
npm run native:github-secrets:setup -- --platform=ios
npm run native:github-secrets:setup -- --platform=macos
npm run native:github-secrets:setup -- --platform=windows
```

For example, Android can be loaded from a local upload keystore path:

```bash
ANDROID_KEYSTORE_PATH=/secure/siragpt-upload-key.jks \
ANDROID_KEYSTORE_PASSWORD=... \
ANDROID_KEY_ALIAS=siragpt \
ANDROID_KEY_PASSWORD=... \
npm run native:github-secrets:setup -- --platform=android
```

The helper pipes values into `gh secret set`; it reports only secret names,
source variable names, and readiness states.

Android signing secrets:

- `ANDROID_KEYSTORE_BASE64`: base64-encoded Play upload keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: upload key alias.
- `ANDROID_KEY_PASSWORD`: upload key password.

Google Play upload secret:

- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`: base64-encoded Google Play service account JSON with Android Publisher API access.

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
6. Enable `upload_android_google_play` only when the signed Android `.aab` should be sent to Google Play. This requires `platform=android` or `platform=all`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`, and the Play Console app/package already configured for `com.siragpt.app`.
7. Set `android_play_track`, `android_release_status`, and `android_user_fraction` only for Android uploads. Keep `android_release_status=draft` for safe first uploads.
8. Enable `upload_ios_app_store_connect` only when the signed iOS `.ipa` should be sent to App Store Connect/TestFlight. This requires `platform=ios` or `platform=all` plus the App Store Connect API key secrets.

The workflow prints only secret names and readiness states. It must not print secret values.
Public GitHub Releases should include `SHA256SUMS.txt` plus the generated
release manifest. Those files are non-secret and are intended to verify that
the downloaded Mac, Windows, iPhone, and Android artifacts match the release
that Actions produced.

After native artifacts exist locally or inside the release workflow, generate
the same verification packet with:

```bash
npm run native:release:manifest -- --dir=output/native-release --out=output/native-release/native-release-manifest.json --markdown-out=output/native-release/native-release-manifest.md --checksums-out=output/native-release/SHA256SUMS.txt
```

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
npm run native:store:owner-packet
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
Use `native:store:owner-packet` to produce the full portable ZIP handoff with
store material, owner checklist, release plan, manifest, and SHA-256 checksum.

## Validation Checklist

Before pushing native release changes:

```bash
node -c apps/desktop/main.cjs
node -c scripts/generate-native-store-assets.js
node -c scripts/generate-native-store-packet.js
node -c scripts/generate-native-store-owner-packet.js
node -c scripts/native-store-assets-readiness.js
node -c scripts/native-store-readiness.js
sh -n scripts/build-desktop.sh
sh -n scripts/setup-native-github-secrets.sh
npm run native:version:check
npm run native:store:readiness
npm run native:store:assets:generate
npm run native:store:assets
npm run native:store:packet -- --require-ready
npm run native:store:owner-packet -- --repo=infosiragpt-ops/SiraGPT-APP --secret-source=env
npm run native:release:handoff -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-owner-handoff.md --json-out=output/native-owner-handoff.json
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
