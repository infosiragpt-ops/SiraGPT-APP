# Sira GPT Mobile Store Release

## Current State

- Current native source version is `0.4.4` / build `4004`.
- Android debug APK QA builds successfully in GitHub Actions.
- Android release AAB QA builds successfully in GitHub Actions.
- Capacitor app ID is `com.siragpt.app`.
- Production WebView URL is `https://siragpt.com`.
- Public GitHub prereleases `native-mobile-qa-v0.4.4-92849df` and
  `desktop-beta-v0.4.4-92849df` contain the current QA packages for Android,
  iPhone Simulator, macOS, and Windows with checksum manifests.
- Native store distribution is tracked in milestone `Native Store Distribution v0.4.4`:
  `https://github.com/infosiragpt-ops/SiraGPT-APP/milestone/1`.
  Platform owner-action issues are #5 Android/Google Play, #6 iPhone/App Store
  Connect, #7 macOS, and #8 Windows.
- The v0.4.4 verification SHA is `92849df80644bfd7bfdbd0e6941c10cfc6b1cca9`; CI, native readiness, mobile, desktop, and signed Android workflows are green for that artifact set.
- Android package signing is configured and verified by the signed AAB release
  `native-android-signed-v0.4.4-92849df`.
- Google Play upload is blocked because the owner account has not completed
  developer enrollment or selected the legal account type.
- iOS and macOS publishing are blocked until the owner completes Apple
  authentication, 2FA, membership, signing, and App Store Connect setup.
- Windows Store publishing is blocked until the owner creates a Microsoft
  account, completes Partner Center enrollment, and chooses the signing path.

## v0.4.4 Candidate Validation

- Full CI: `29974467795`.
- Native readiness report: `29975517523`.
- Native mobile builds: `29975515640`.
- Native desktop release: `29975516582`.
- Native signed Android release: `29975518333`.
- Mobile QA prerelease:
  `https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-mobile-qa-v0.4.4-92849df`.
- Desktop beta prerelease:
  `https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/desktop-beta-v0.4.4-92849df`.
- Signed Android release:
  `https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-android-signed-v0.4.4-92849df`.
- Fresh GitHub-download checksum verification passed for the Android APK/AAB,
  iPhone Simulator ZIP, macOS Apple Silicon DMG, Windows installer/portable
  files, and owner handoff packet.
- The iPhone Simulator ZIP validates the wrapper but cannot be installed on a
  physical iPhone. A signed IPA remains blocked on Apple credentials.
- The current non-secret owner handoff packet is
  `SiraGPT-native-store-owner-packet-92849df8.zip`; its SHA-256 is
  `8e0aa119309c9866eaa0384c6adb14b1f25b74174915dcbde8f814c43f32e6d0`.
  It is stored in readiness artifact `8551252488`.

## Current Vendor Account Readiness

- Google Play: the designated owner reaches the Play Console enrollment page,
  but no developer account exists. The owner must choose personal or
  organization enrollment; this choice must not be automated.
- Apple: the owner identifier is recognized. Password entry, 2FA, membership
  status, and organization details remain owner-controlled steps.
- Microsoft: no Microsoft account currently exists for the designated owner
  address. Account creation and Partner Center enrollment are required.
- No password, 2FA code, payment, legal agreement, or identity document is
  stored in this repository or in the handoff packet.

## Previous v0.4.3 Production Baseline

- `npm run mobile:doctor` passed locally for Android and iOS.
- `npm run native:version:check` passed locally for native version `0.4.3` / build `4003` during the previous baseline validation.
- `npm run native:store:readiness` passed locally against the submission metadata.
- `npm run native:store:assets:generate` creates the current store screenshots
  and Google Play feature graphic under `docs/store-submission/assets/`.
- `npm run native:store:assets` validates the packaged app icons and generated
  store assets without reading signing credentials.
- `npm run native:store:packet` exports platform-specific, non-secret submission
  folders under `output/native-store-submission-packet/`.
- GitHub Actions `Native mobile builds` run `28760576620` passed on `production-main` SHA `bffcbf75ec0ef5be18d1d3dc8672e92708df1f40`.
- The run produced QA artifacts:
  - `siragpt-mobile-android`
  - `siragpt-mobile-ios-simulator`
- The Android upload was downloaded and its manifest lists
  `SiraGPT-bffcbf7-debug.apk` and
  `SiraGPT-bffcbf7-signed-release.aab` with SHA-256 checksums.
- GitHub Actions `Native desktop builds` run `28760576641` passed on the same SHA and produced QA artifacts:
  - `siragpt-desktop-macos`
  - `siragpt-desktop-windows-x64`
- The iOS simulator, macOS, and Windows uploads were downloaded and each
  contains `native-release-manifest.json`, `native-release-manifest.md`, and
  `SHA256SUMS.txt`.
- GitHub Actions `Native readiness report` run `28760576640` passed on the native artifact traceability SHA and produced the non-secret release plan/store packet.
- Native QA artifact target is `bffcbf75ec0ef5be18d1d3dc8672e92708df1f40`; current owner-handoff management evidence is tracked by commit `bffcbf75ec0ef5be18d1d3dc8672e92708df1f40`.
- Latest green wrapper and management runs:
  - CI: `28759688295`
  - CodeQL: `28759689486`
  - Native readiness report: `28760576640`
  - Native mobile builds: `28760576620`
  - Native desktop builds: `28760576641`
  - Android signed release packages: `28760576624`
  - Docker build images: `28735031878`
- Current production-main wrapper validation SHA:
  `bffcbf75ec0ef5be18d1d3dc8672e92708df1f40`
  (`chore(ui-lock): refresh code panel baseline`) is green in CI, CodeQL, native readiness, Native mobile builds, Android signed release packages, and
  Native desktop builds. The mobile run produced Android APK/AAB and iPhone
  simulator QA artifacts; the desktop run produced macOS and Windows QA
  artifacts. All platform uploads include `native-release-manifest.json`,
  `native-release-manifest.md`, and `SHA256SUMS.txt`. The downloaded artifact
  contents include `SiraGPT-bffcbf7-debug.apk`,
  `SiraGPT-bffcbf7-signed-release.aab`,
  `SiraGPT-bffcbf7-ios-simulator-app.zip`, `SiraGPT-0.4.3-arm64.dmg`,
  `SiraGPT-0.4.3-arm64-mac.zip`, `SiraGPT Setup 0.4.3.exe`, and
  `SiraGPT 0.4.3.exe`.
- Management/traceability commit validated before this document refresh:
  `bffcbf75ec0ef5be18d1d3dc8672e92708df1f40`
  (`chore(ui-lock): refresh code panel baseline`) is green in CI run
  `28759688295`, CodeQL run `28759689486`, and Native readiness report run
  `28760576640`.
- GitHub repository diagnostics:
  - Repository visibility: `PUBLIC`
  - Actions enabled: `true`
  - Allowed actions: `all`
  - Result: public-repository Actions are not the blocker; missing native signing/store-upload secrets are.
- Signed native preflight run `28748232904` was triggered for `platform=all`
  on SHA `26f5d5950ae3bf052f227d43e87faf5a3973203c` and stopped before package runners because Android, iOS, macOS, and Windows signing secrets are still missing. It uploaded `siragpt-native-signed-release-preflight` with `preflight.md` and `preflight.json` before stopping.
- Signed Android release run `28760576624` passed on SHA
  `bffcbf75ec0ef5be18d1d3dc8672e92708df1f40` and published
  `SiraGPT-bffcbf7.aab` to
  `https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-android-signed-v0.4.3-bffcbf7`.
  Local checksum verification passed for `preflight.json`, `preflight.md`, and
  the signed `.aab`; the AAB SHA-256 is
  `9aa139e5783df37a3bd8d852e19c32fdc37c861eae7e0bb9574094e32394d348`.
- Latest owner handoff packet: `SiraGPT-native-store-owner-packet-bffcbf7.zip`
  (`sha256:6b2e62e087483966c1a960d32aa1402cece5c5b3e19899870684ff443c61d8b2`) is attached to
  `https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-android-signed-v0.4.3-bffcbf7`.
- Signed native GitHub Releases generated through `Native signed release packages` include `native-release-manifest.json`, `native-release-manifest.md`, and `SHA256SUMS.txt` when `create_github_release` is enabled. The signed release preflight also uploads `siragpt-native-signed-release-preflight` with `preflight.md` and `preflight.json`, even when the run intentionally stops because signing/upload secrets are missing.
- `Native mobile builds` and `Native desktop builds` QA artifacts also include
  `native-release-manifest.json`, `native-release-manifest.md`, and
  `SHA256SUMS.txt` in each platform upload so the generated Android, iPhone
  simulator, macOS, and Windows files can be verified before signing or store
  submission.
- Public QA prerelease:
  - `https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-qa-v0.4.3-bffcbf7`
- Local downloaded QA artifacts:
  - `output/native-current-bffcbf7/mobile/android/android/SiraGPT-bffcbf7-debug.apk`
  - `output/native-current-bffcbf7/mobile/android/android/SiraGPT-bffcbf7-signed-release.aab`
  - `output/native-current-bffcbf7/mobile/ios/ios/SiraGPT-bffcbf7-ios-simulator-app.zip`
  - `output/native-current-bffcbf7/desktop/macos/macos/SiraGPT-0.4.3-arm64.dmg`
  - `output/native-current-bffcbf7/desktop/macos/macos/SiraGPT-0.4.3-arm64-mac.zip`
  - `output/native-current-bffcbf7/desktop/windows/windows/SiraGPT Setup 0.4.3.exe`
  - `output/native-current-bffcbf7/desktop/windows/windows/SiraGPT 0.4.3.exe`
  - `output/SiraGPT-native-qa-v0.4.3-bffcbf7.zip`

## Current GitHub Secrets State

The public repository has VPS deployment secrets and Android package-signing
secrets configured. Signed store distribution is not fully ready until the
remaining native release secrets are added to GitHub Actions:

- Android: package signing is ready with `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and
  `ANDROID_KEY_PASSWORD`; Google Play upload still needs
  `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`.
- iOS/App Store Connect: `APPLE_TEAM_ID`, `IOS_SIGNING_CERTIFICATE_BASE64`, `IOS_SIGNING_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_BASE64`.
- macOS: `MACOS_CERTIFICATE_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`.
- Windows: `WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`.

Do not commit account passwords, keystores, certificates, provisioning profiles,
or app-specific passwords. Add them only as GitHub Actions secrets or directly
inside the vendor store portals.
Normal email/account passwords are not valid native signing credentials. Use
dedicated upload keys, certificates, provisioning profiles, App Store Connect
API keys, and Apple app-specific passwords for the signing workflow.
If a mailbox password reached a public commit, rotate it outside GitHub and do
not reuse it for signing or store automation.

Latest secret-name audit:

```bash
npm run native:github-secrets:audit -- --repo=infosiragpt-ops/SiraGPT-APP --require=all --only-required
npm run native:github-secrets:report -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-github-secrets-report.md --json-out=output/native-github-secrets-report.json
```

Result: `android` is ready for package signing. `googleplay`, `ios`,
`appstore`, `macos`, and `windows` are still missing required native
signing/upload secrets. The audit prints names and readiness states only; it
does not read or print secret values. The report command writes a shareable
Markdown/JSON diagnosis for the same blocker.
This is the signed-release blocker. It is separate from public repository
GitHub Actions availability, which is currently verified by green CI and native
QA workflows.

## Current Google Play Blockers

The designated Google account reaches the Play Console enrollment page, but it
does not have a developer account. The owner must first choose one of these
account types:

- Organization: requires a verifiable legal entity and D-U-N-S information.
- Personal: uses the owner's legal identity and has different verification and
  testing requirements.

The account-type choice, identity verification, agreements, and developer fee
are owner actions. They cannot be completed by CI or local automation.

## Android Play Store Path

1. Confirm whether SiraGPT enrolls as a legal organization or personal account.
2. Complete Play Console enrollment, payment, agreements, and owner verification.
3. Create the app for package `com.siragpt.app`.
4. Create a Google Play service account with Android Publisher API access.
5. Store its JSON as `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` in GitHub Actions secrets.
6. Run `Native signed release packages` with `platform=android`, `upload_android_google_play=true`, `android_play_track=qa`, and `android_release_status=draft`.
7. Review the internal-testing draft in Play Console.
8. Complete app access, ads, content rating, target audience, data safety,
   privacy policy, store listing, screenshots, and release notes.
9. Submit a production release only after a final manual confirmation.

## iOS App Store Path

1. Complete owner sign-in and 2FA.
2. Confirm or enroll in the Apple Developer Program and record the Team ID.
3. Install full Xcode and select it with `xcode-select`.
4. Open the project with `npm run mobile:open:ios`.
5. Configure signing for bundle ID `com.siragpt.app`.
6. Add the Apple signing secrets and App Store Connect API key secrets to GitHub Actions.
7. Run `Native signed release packages` with `platform=ios` and enable `upload_ios_app_store_connect` only when the signed `.ipa` should be uploaded.
8. Alternatively, archive from Xcode and upload to App Store Connect manually.
9. Complete privacy nutrition labels, age rating, screenshots, app review
   information, pricing/availability, and TestFlight review.
10. Submit to App Review only after a final manual confirmation.

## Store Listing Draft

- App name: Sira GPT
- Short description: AI assistant for chat, documents, voice, search, and productivity workflows.
- Category: Productivity
- Support URL: `https://siragpt.com`
- Privacy policy URL: `https://siragpt.com/privacy-policy`

The canonical non-secret submission packet is
`docs/store-submission/native-store-metadata.json`, with asset requirements in
`docs/store-submission/native-store-assets.json`. Run
`npm run native:store:readiness` and `npm run native:store:assets` before using
it in Google Play Console or App Store Connect.

To generate a current, non-secret management checklist for the public GitHub
repo, run:

```bash
npm run native:store:assets:generate
npm run native:store:assets -- --require-ready
npm run native:store:packet -- --require-ready
npm run native:github-secrets:template -- --platform=mobile --out=output/native-mobile-signing.env.example
npm run native:github-secrets:setup -- --platform=mobile --dry-run
npm run native:github-secrets:report -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-github-secrets-report.md --json-out=output/native-github-secrets-report.json
npm run native:release:plan -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-release-plan.md --json-out=output/native-release-plan.json
npm run native:release:handoff -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-owner-handoff.md --json-out=output/native-owner-handoff.json
```

The generated files stay under ignored `output/` and may list missing secret
names plus account-owner actions, but they must never contain secret values.
The secret template and setup dry-run report only missing or ready secret names,
file-path variable names, and source variable names. They do not print values.
The release plan also reports a release gate summary so the first Android run
can stay on the `qa` track with `draft` status and the first iPhone upload can
be held until App Store Connect upload is explicitly approved.
The GitHub Actions workflow `Native readiness report` publishes the same
non-secret checklist, owner handoff packet, and asset readiness report as an artifact named
`siragpt-native-readiness-report`.

## Required Confirmations

- Creating the Android upload key creates a long-lived signing credential.
- Uploading `.aab` or `.ipa` sends app binaries to Google/Apple.
- Enabling `upload_android_google_play` in GitHub Actions uploads the signed Android binary to the selected Google Play track.
- Enabling `upload_ios_app_store_connect` in GitHub Actions uploads the signed iOS binary to App Store Connect/TestFlight.
- Creating or submitting store listings publishes text and metadata to third parties.
- Paying developer fees or submitting apps for review requires explicit confirmation at action time.
