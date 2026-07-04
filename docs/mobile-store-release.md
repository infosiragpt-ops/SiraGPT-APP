# Sira GPT Mobile Store Release

## Current State

- Android debug APK QA builds successfully in GitHub Actions.
- Android release AAB QA builds successfully in GitHub Actions.
- Capacitor app ID is `com.siragpt.app`.
- Production WebView URL is `https://siragpt.com`.
- Public GitHub prerelease `native-qa-v0.4.3-884cbec` contains unsigned QA packages for Android, iOS simulator, macOS, and Windows.
- Android signed Play release publishing is blocked until the Play upload keystore secrets are configured in GitHub Actions and Google Play account verification is complete.
- iOS publishing is blocked until Apple Developer signing assets, App Store Connect access, and Apple account verification are configured.

## Latest Validation

- `npm run mobile:doctor` passed locally for Android and iOS.
- `npm run native:version:check` passed locally for native version `0.4.3` / build `4003`.
- `npm run native:store:readiness` passed locally against the submission metadata.
- `npm run native:store:assets:generate` creates the current store screenshots
  and Google Play feature graphic under `docs/store-submission/assets/`.
- `npm run native:store:assets` validates the packaged app icons and generated
  store assets without reading signing credentials.
- GitHub Actions `Native mobile builds` run `28719956528` passed on `production-main` SHA `884cbec329822fa3590165fafea40c27edb10e95`.
- The run produced unsigned QA artifacts:
  - `siragpt-mobile-android`
  - `siragpt-mobile-ios-simulator`
- GitHub Actions `Native desktop builds` run `28719956526` passed on the same SHA and produced unsigned QA artifacts:
  - `siragpt-desktop-macos`
  - `siragpt-desktop-windows-x64`
- Public QA prerelease:
  - `https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-qa-v0.4.3-884cbec`
- Local downloaded QA artifacts:
  - `output/native-qa/release-884cbec32/SiraGPT-0.4.3-android-debug.apk`
  - `output/native-qa/release-884cbec32/SiraGPT-0.4.3-android-qa.aab`
  - `output/native-qa/release-884cbec32/SiraGPT-0.4.3-ios-simulator-app.zip`
  - `output/native-qa/release-884cbec32/SiraGPT-0.4.3-macos-arm64.dmg`
  - `output/native-qa/release-884cbec32/SiraGPT-0.4.3-macos-arm64.zip`
  - `output/native-qa/release-884cbec32/SiraGPT-Setup-0.4.3-windows-x64.exe`
  - `output/native-qa/release-884cbec32/SiraGPT-Portable-0.4.3-windows-x64.exe`
  - `output/native-qa/release-884cbec32/SHA256SUMS.txt`

## Current GitHub Secrets State

The public repository currently has only VPS deployment secrets configured.
Signed store distribution is not ready until these native release secrets are
added to GitHub Actions:

- Android: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- iOS/App Store Connect: `APPLE_TEAM_ID`, `IOS_SIGNING_CERTIFICATE_BASE64`, `IOS_SIGNING_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_BASE64`.
- macOS: `MACOS_CERTIFICATE_BASE64`, `MACOS_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`.
- Windows: `WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`.

Do not commit account passwords, keystores, certificates, provisioning profiles,
or app-specific passwords. Add them only as GitHub Actions secrets or directly
inside the vendor store portals.

## Current Google Play Blockers

Google Play Console shows the app in draft state and blocks publishing because the developer account is not fully configured. The account page lists:

- Verify identity: only the account owner can upload documents.
- Verify access to a real Android mobile device through the Play Console mobile app.
- Verify contact phone number: only the account owner can verify it.

These are account-owner actions and cannot be completed by build tooling or local automation without the owner's documents, phone, and real Android device.

## Android Play Store Path

1. Complete the Google Play developer account verification as the account owner.
2. Return to the internal testing release in Google Play Console.
3. Publish the prepared internal testing release if the review page enables `Guardar y publicar`.
4. For production, complete app access, ads, content rating, target audience, data safety, privacy policy, store listing, screenshots, and release notes.
5. Submit the production release only after a final manual confirmation.

## iOS App Store Path

1. Install full Xcode and select it with `xcode-select`.
2. Sign in to Xcode with an Apple Developer account.
3. Open the project with `npm run mobile:open:ios`.
4. Configure signing for bundle ID `com.siragpt.app`.
5. Archive from Xcode and upload to App Store Connect.
6. Complete privacy nutrition labels, age rating, screenshots, app review information, pricing/availability, and TestFlight review.
7. Submit to App Review only after a final manual confirmation.

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
npm run native:release:plan -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-release-plan.md --json-out=output/native-release-plan.json
```

The generated files stay under ignored `output/` and may list missing secret
names plus account-owner actions, but they must never contain secret values.
The GitHub Actions workflow `Native readiness report` publishes the same
non-secret checklist and asset readiness report as an artifact named
`siragpt-native-readiness-report`.

## Required Confirmations

- Creating the Android upload key creates a long-lived signing credential.
- Uploading `.aab` or `.ipa` sends app binaries to Google/Apple.
- Creating or submitting store listings publishes text and metadata to third parties.
- Paying developer fees or submitting apps for review requires explicit confirmation at action time.
