# Sira GPT Mobile Store Release

## Current State

- Android debug APK exists at `output/SiraGPT-android-debug.apk`.
- Android release AAB exists at `output/SiraGPT-android-release.aab`.
- Capacitor app ID is `com.siragpt.app`.
- Production WebView URL is `https://siragpt.com`.
- Android release signing is configured with the local upload key at `android/keystores/siragpt-upload-key.jks` and ignored secret properties at `android/keystore.properties`.
- Android release publishing reached Google Play Console review for internal testing, but `Guardar y publicar` is blocked by developer account verification.
- Android emulator validation is configured with AVD `SiraGPT_API36`; the debug APK installs and launches successfully.
- iOS publishing is blocked on installing full Xcode and signing with an Apple Developer account.

## Latest Validation

- `npm run mobile:sync` completed for Android and iOS.
- GitHub Actions `Native mobile builds` run `28715288814` passed on `production-main` SHA `4bbd7dc6d64a5a6d4f4a687c346ef8b9248f6747`.
- The run produced fresh unsigned QA artifacts:
  - `siragpt-mobile-android`
  - `siragpt-mobile-ios-simulator`
- Android SDK, emulator, platform tools, OpenJDK 21, `sdkmanager`, `avdmanager`, `adb`, and `jarsigner` are configured in `~/.zshrc` and `~/.zprofile`.
- AVD `SiraGPT_API36` was created from `system-images;android-36;google_apis;arm64-v8a`.
- `output/SiraGPT-android-debug.apk` installed on emulator `emulator-5554`.
- `com.siragpt.app/.MainActivity` launched and loaded the Sira GPT WebView.
- Navigation from the welcome screen to the sign-up screen was validated.
- Android declares `android.permission.RECORD_AUDIO`; runtime permission is initially ungranted, as expected until the app asks for microphone access.
- Screenshots:
  - `output/SiraGPT-android-emulator-launch.png`
  - `output/SiraGPT-android-emulator-signup.png`
- Release AAB SHA-256: `3a1bb3349735df06ab73b9e34842179d594ec0ead9956e4601a4e5e3836f469f`.
- Debug APK SHA-256: `8779645166ca8bf3483c4a368d98358acbe10e342d2f7cc200c8c20190e7519f`.
- Upload key SHA-256: `c9afa1c1945681bb1b12587e399793907e341159019bb477579e3c607b1bbaa8`.

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
`docs/store-submission/native-store-metadata.json`. Run
`npm run native:store:readiness` before using it in Google Play Console or
App Store Connect.

## Required Confirmations

- Creating the Android upload key creates a long-lived signing credential.
- Uploading `.aab` or `.ipa` sends app binaries to Google/Apple.
- Creating or submitting store listings publishes text and metadata to third parties.
- Paying developer fees or submitting apps for review requires explicit confirmation at action time.
