# Sira GPT Mobile Store Release

## Current State

- Android debug APK QA builds successfully in GitHub Actions.
- Android release AAB QA builds successfully in GitHub Actions.
- Capacitor app ID is `com.siragpt.app`.
- Production WebView URL is `https://siragpt.com`.
- Public GitHub prerelease `native-qa-v0.4.3-0fb0493` contains unsigned QA packages for Android, iOS simulator, macOS, and Windows.
- The current repository validation SHA is `1e657aaf40853df5a3f844b86028a17fae88cad0`; CI, Docker image build, native readiness, native mobile, and native desktop workflows are green.
- Android signed Play release publishing is blocked until the Play upload keystore secrets, the Google Play service account upload secret, and Google Play account verification are complete.
- iOS publishing is blocked until Apple Developer signing assets, App Store Connect access, and Apple account verification are configured.

## Latest Validation

- `npm run mobile:doctor` passed locally for Android and iOS.
- `npm run native:version:check` passed locally for native version `0.4.3` / build `4003`.
- `npm run native:store:readiness` passed locally against the submission metadata.
- `npm run native:store:assets:generate` creates the current store screenshots
  and Google Play feature graphic under `docs/store-submission/assets/`.
- `npm run native:store:assets` validates the packaged app icons and generated
  store assets without reading signing credentials.
- `npm run native:store:packet` exports platform-specific, non-secret submission
  folders under `output/native-store-submission-packet/`.
- GitHub Actions `Native mobile builds` run `28729582734` passed on `production-main` SHA `e71443c46699d235cddb73102830c92982298765`.
- The run produced unsigned QA artifacts:
  - `siragpt-mobile-android`
  - `siragpt-mobile-ios-simulator`
- GitHub Actions `Native desktop builds` run `28729583294` passed on the same SHA and produced unsigned QA artifacts:
  - `siragpt-desktop-macos`
  - `siragpt-desktop-windows-x64`
- GitHub Actions `Native readiness report` run `28729412226` passed on the current traceability SHA and produced the non-secret release plan/store packet.
- Current traceability commit `e71443c46699d235cddb73102830c92982298765` keeps the owner handoff packet aligned with the current signed preflight and is green in GitHub Actions:
  - CI: `28729412232`
  - Native readiness report: `28729412226`
  - Native mobile builds: `28729582734`
  - Native desktop builds: `28729583294`
  - Docker build images: `28727085650`
- Signed native preflight run `28728938916` was triggered for `platform=all`
  on SHA `5970953f4c72a3f39850ac679a5d9b7f3a939c49` and stopped before
  package runners because Android, iOS, macOS, and Windows signing secrets are
  still missing.
- Latest owner handoff packet: `SiraGPT-native-store-owner-packet-47bc2475.zip`
  (`sha256:490bddebff1a2e64653a5986c1b98dd35a6347972512c2dc563e758aecc96926`).
- Signed native GitHub Releases generated through `Native signed release packages` include `native-release-manifest.json`, `native-release-manifest.md`, and `SHA256SUMS.txt` when `create_github_release` is enabled.
- Public QA prerelease:
  - `https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-qa-v0.4.3-0fb0493`
- Local downloaded QA artifacts:
  - `output/native-qa-release-0fb0493/android/SiraGPT-0.4.3-0fb0493-debug.apk`
  - `output/native-qa-release-0fb0493/android/SiraGPT-0.4.3-0fb0493-play-upload-qa.aab`
  - `output/native-qa-release-0fb0493/ios/SiraGPT-0.4.3-0fb0493-ios-simulator-app.zip`
  - `output/native-qa-release-0fb0493/macos/SiraGPT-0.4.3-0fb0493-arm64.dmg`
  - `output/native-qa-release-0fb0493/macos/SiraGPT-0.4.3-0fb0493-arm64-mac.zip`
  - `output/native-qa-release-0fb0493/windows/SiraGPT-Setup-0.4.3-0fb0493-x64.exe`
  - `output/native-qa-release-0fb0493/windows/SiraGPT-0.4.3-0fb0493-x64-portable.exe`
  - `output/native-qa-release-0fb0493/SHA256SUMS.txt`

## Current GitHub Secrets State

The public repository currently has only VPS deployment secrets configured.
Signed store distribution is not ready until these native release secrets are
added to GitHub Actions:

- Android: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64`.
- iOS/App Store Connect: `APPLE_TEAM_ID`, `IOS_SIGNING_CERTIFICATE_BASE64`, `IOS_SIGNING_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_BASE64`.
- macOS: `MACOS_CERTIFICATE_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`.
- Windows: `WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`.

Do not commit account passwords, keystores, certificates, provisioning profiles,
or app-specific passwords. Add them only as GitHub Actions secrets or directly
inside the vendor store portals.
Normal email/account passwords are not valid native signing credentials. Use
dedicated upload keys, certificates, provisioning profiles, App Store Connect
API keys, and Apple app-specific passwords for the signing workflow.

Latest secret-name audit:

```bash
npm run native:github-secrets:audit -- --repo=infosiragpt-ops/SiraGPT-APP --require=all --only-required
```

Result: `android`, `googleplay`, `ios`, `appstore`, `macos`, and `windows`
are missing required native signing/upload secrets. The audit prints names and
readiness states only; it does not read or print secret values.

## Current Google Play Blockers

Google Play Console shows the app in draft state and blocks publishing because the developer account is not fully configured. The account page lists:

- Verify identity: only the account owner can upload documents.
- Verify access to a real Android mobile device through the Play Console mobile app.
- Verify contact phone number: only the account owner can verify it.

These are account-owner actions and cannot be completed by build tooling or local automation without the owner's documents, phone, and real Android device.

## Android Play Store Path

1. Complete the Google Play developer account verification as the account owner.
2. Create or select a Google Play service account with Android Publisher API access for package `com.siragpt.app`.
3. Store the service account JSON as `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` in GitHub Actions secrets.
4. Run `Native signed release packages` with `platform=android`, `upload_android_google_play=true`, `android_play_track=qa`, and `android_release_status=draft` for the first safe upload.
5. Return to the internal testing release in Google Play Console and review the draft.
6. Publish the prepared internal testing release if the review page enables `Guardar y publicar`.
7. For production, complete app access, ads, content rating, target audience, data safety, privacy policy, store listing, screenshots, and release notes.
8. Submit the production release only after a final manual confirmation.

## iOS App Store Path

1. Install full Xcode and select it with `xcode-select`.
2. Sign in to Xcode with an Apple Developer account.
3. Open the project with `npm run mobile:open:ios`.
4. Configure signing for bundle ID `com.siragpt.app`.
5. Add the Apple Developer signing secrets and App Store Connect API key secrets to GitHub Actions.
6. Run `Native signed release packages` with `platform=ios` and enable `upload_ios_app_store_connect` when the signed `.ipa` should be uploaded automatically.
7. Alternatively, archive from Xcode and upload to App Store Connect manually.
8. Complete privacy nutrition labels, age rating, screenshots, app review information, pricing/availability, and TestFlight review.
9. Submit to App Review only after a final manual confirmation.

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
npm run native:release:plan -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-release-plan.md --json-out=output/native-release-plan.json
npm run native:release:handoff -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-owner-handoff.md --json-out=output/native-owner-handoff.json
```

The generated files stay under ignored `output/` and may list missing secret
names plus account-owner actions, but they must never contain secret values.
The secret template and setup dry-run report only missing or ready secret names,
file-path variable names, and source variable names. They do not print values.
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
