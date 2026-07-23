# Native Store Submission Packet

This folder tracks the non-secret submission material for turning SiraGPT
into installable native apps for Android, iPhone, macOS, and Windows.

It is deliberately split from signing credentials. Store account passwords,
keystores, certificates, provisioning profiles, API keys, and app-specific
passwords must be stored only in the vendor portals or GitHub Actions
secrets. They must never be committed.

## Current Native Identity

- Product: `Sira GPT`
- Android package: `com.siragpt.app`
- iOS bundle ID: `com.siragpt.app`
- macOS bundle ID: `com.siragpt.desktop`
- Windows app ID: `com.siragpt.desktop`
- Runtime URL: `https://siragpt.com`
- Privacy policy: `https://siragpt.com/privacy-policy`
- Support email: `infosiragpt@gmail.com`
- Category: Productivity
- Current QA source: `1d5e24c6c0a4e596e88be25ff1cfb2c728b86697`
  on `production-main`.
- Current verified workflow runs:
  - CI: `30046964522`
  - Native readiness: `30047839509`
  - Mobile QA wrappers: `30047818708`
  - Desktop QA packages: `30047079626`
  - Android certificate gate: `30048082193`
- Current mobile QA assets include a debug APK, an iOS Simulator ZIP, unsigned
  iOS device-build evidence, checksums, and
  `android-upload-certificate-blocker.json`. They deliberately do not include
  an AAB or IPA presented as store-ready.
- Current desktop QA assets include macOS DMG/ZIP packages, Windows NSIS and
  portable executables, and `SiraGPT-Store-0.4.4-x64.appx`. The AppX uses QA
  identity, is not directly installable, and is not Partner Center
  submission-ready.
- Durable QA releases:
  - Mobile: https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/native-mobile-qa-v0.4.4-1d5e24c
  - Desktop: https://github.com/infosiragpt-ops/SiraGPT-APP/releases/tag/desktop-beta-v0.4.4-1d5e24c
- Distribution tracker: https://github.com/infosiragpt-ops/SiraGPT-APP/issues/4
- Distribution milestone: https://github.com/infosiragpt-ops/SiraGPT-APP/milestone/1
- Platform owner-action issues:
  - Android / Google Play: https://github.com/infosiragpt-ops/SiraGPT-APP/issues/5
  - iPhone / App Store Connect: https://github.com/infosiragpt-ops/SiraGPT-APP/issues/6
  - macOS Developer ID / notarization: https://github.com/infosiragpt-ops/SiraGPT-APP/issues/7
  - Windows signing / Microsoft Store: https://github.com/infosiragpt-ops/SiraGPT-APP/issues/8
- The Android signing secret-name preflight passed in run `30048082193`, then
  the certificate gate correctly failed before publishing any bundle. The
  configured keystore does not match the Google Play upload certificate.
- `native-android-signed-v0.4.4-dd87ccb` is retained only as a historical QA
  prerelease. Its APK/AAB signatures and checksums are internally valid, but
  its AAB is not compatible with the current Google Play app and must not be
  uploaded there.
- Current secret-name audit: Android keystore secret names exist. Google Play
  service-account credentials, Apple signing/App Store credentials, macOS
  signing/notarization credentials, Windows direct-signing credentials, and
  Microsoft Partner Center identity variables are still missing.
- No vendor-store publication has been proven. Store enrollment, legal
  agreements, identity verification, reviewer access, final questionnaires,
  package acceptance, review, and publication remain owner/vendor gates.

Security note: a mailbox password literal reached a prior public management
commit and the branch was force-updated to remove it. Treat that mailbox
password as exposed and rotate it outside GitHub. Do not use mailbox passwords
as native signing material.

Store owner account note: use `infosiragpt@gmail.com` only as the owner mailbox
for Apple Developer, App Store Connect, Google Play Console, and Microsoft
Partner Center setup. Rotate the mailbox password and enable MFA before using it
in those portals. The mailbox password must never be added to GitHub Actions;
native release automation requires vendor-specific API keys, app-specific
passwords, upload keys, certificates, and provisioning profiles.

The canonical draft metadata lives in
`docs/store-submission/native-store-metadata.json`. The store asset manifest
lives in `docs/store-submission/native-store-assets.json`.

## Submission Order

1. Keep `production-main` green for web, desktop, and mobile wrapper builds.
   The `Native mobile builds` and `Native desktop builds` workflow artifacts
   must include `native-release-manifest.json`, `native-release-manifest.md`,
   and `SHA256SUMS.txt` alongside every QA binary upload.
   The Windows upload also contains a validated AppX and
   `windows-store-package.json`; QA identity is evidence of package health,
   while `storeSubmissionReady: true` requires the exact reserved Partner
   Center identity.
2. Complete owner-only account verification in Google Play Console and Apple
   Developer/App Store Connect.
3. Replace or recover the Android upload keystore whose SHA-1 matches the
   Google Play upload identity, then add remaining signing and store-upload
   secrets to GitHub Actions. Secret names and values must never be committed.
4. Run `npm run native:store:readiness`, `npm run native:store:assets`, and
   `npm run native:readiness:all`.
5. Build signed packages through `Native signed release packages`.
   Its preflight writes a GitHub Actions step summary with the selected platform,
   release tag, missing secret names, and safe next steps before stopping.
6. Enable `create_github_release` when the signed artifacts should be published
   with `native-release-manifest.json`, `native-release-manifest.md`, and
   `SHA256SUMS.txt`.
7. For Android, enable `upload_android_google_play` only when the signed
   `.aab` should be uploaded to Google Play from GitHub Actions.
8. For iPhone, enable `upload_ios_app_store_connect` only when the signed
   `.ipa` should be uploaded to App Store Connect/TestFlight from GitHub
   Actions.
9. Upload only after manual confirmation because binaries and store metadata
   are transmitted to third-party platforms.

Do not use a normal email or account password as a native signing secret.
Distribution requires dedicated signing material: Android upload keystore,
Google Play service account JSON for automated Play uploads,
Apple certificates/profiles and app-specific password, App Store Connect API
key, and a Windows code-signing certificate for direct EXE distribution.
Microsoft Store AppX submission is a distinct route: the Store applies its
distribution signature, while SiraGPT must supply the exact non-secret
Partner Center identity values.

## Platform Notes

### Android

Google Play requires the Data safety form and a privacy policy for published
apps. The draft data declaration is in the metadata JSON and must be reviewed
against the live app behavior, all providers, and SDKs before submission.

Current account blockers are owner actions:

- Identity verification.
- Real Android device verification in Play Console.
- Contact phone verification.

The signed release workflow can upload the generated `.aab` automatically when
`upload_android_google_play` is enabled and
`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` is configured. The first automated
upload should target `android_play_track=qa` with
`android_release_status=draft` so the owner can review it in Google Play
Console before publishing.

Android package-signing secret names exist, but the configured keystore SHA-1
does not match the Google Play upload certificate. The workflow must continue
to stop before upload until the owner supplies the matching upload keystore or
completes Google Play's upload-key reset process. The service account
`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64` is a separate missing requirement for
automated uploads. Historical signed AAB files are QA evidence only and must
not be uploaded to the current Play app.

### iPhone

App Store Connect requires app privacy details, privacy policy URL, age rating,
screenshots, review information, signing, and an uploaded build. The app uses
the Capacitor bundle ID `com.siragpt.app`; do not create a different bundle ID
unless the native project and metadata are updated together. The signed release
workflow can upload the generated `.ipa` automatically when
`upload_ios_app_store_connect` is enabled and the App Store Connect API key
secrets are configured.

### macOS

The desktop shell is configured for hardened runtime and notarization. A public
downloadable build still needs a Developer ID Application certificate and
Apple notarization credentials in GitHub Actions secrets.

### Windows

The Windows package has two independent distribution routes:

- `npm run desktop:dist:win` builds NSIS installer and portable executable.
  Sign both with a trusted Windows code-signing certificate before direct
  public distribution.
- `npm run desktop:dist:win:store` builds an AppX for Microsoft Store.
  Partner Center applies the distribution signature, but the package must use
  the exact reserved values from `WINDOWS_STORE_IDENTITY_NAME`,
  `WINDOWS_STORE_PUBLISHER`,
  `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`, and
  `WINDOWS_STORE_APPLICATION_ID`.

The build rejects partial Store identity. Without all four values it produces
only a clearly labelled QA package. Validate either package with
`npm run desktop:validate:win:store`; the workflow records mode, identity,
SHA-256, direct-install status, and Store-submission status in
`windows-store-package.json`. Microsoft Store listing metadata, logos,
screenshots, privacy URL, account enrollment, and final certification remain
Partner Center actions.

## Privacy Declaration Draft

SiraGPT should be declared as collecting user-linked data for account
management, app functionality, security, support, diagnostics, and payment
management. This includes user-provided chats, prompts, projects, files,
documents, uploaded images/audio/voice when those features are used, account
identifiers, subscription status, diagnostics, app interactions, and technical
session data.

The current draft declares:

- No third-party advertising.
- No tracking for advertising.
- Encryption in transit.
- User deletion/privacy requests through the published privacy policy.

Before submission, reconcile this draft with the production provider list,
analytics tools, payment processors, AI model providers, crash reporting, and
any SDKs bundled into native shells.

## Readiness Commands

```bash
npm run native:store:readiness
npm run native:store:assets:generate
npm run native:store:assets
npm run native:store:packet
npm run native:store:owner-packet
npm run native:readiness
npm run native:readiness:all
npm run native:github-secrets:audit
npm run native:github-secrets:check
npm run native:github-secrets:report -- --repo=infosiragpt-ops/SiraGPT-APP --out=output/native-github-secrets-report.md --json-out=output/native-github-secrets-report.json
npm run native:github-secrets:template -- --platform=all --out=output/native-signing.env.example
npm run native:github-secrets:setup -- --platform=all --dry-run
npm run native:release:plan
npm run native:release:plan:ci
npm run desktop:assets:win:store -- --check
npm run desktop:dist:win:store
npm run desktop:validate:win:store
```

`native:store:readiness` validates that the metadata packet matches the real
native package IDs and required public URLs. `native:store:assets` validates
packaged app icons and public store-listing assets such as screenshots and the
Google Play feature graphic. By default it reports `blocked` without failing
CI; use `npm run native:store:assets -- --require-ready` when preparing the
final store upload. `native:readiness:all` validates that signing secret names
are present in the execution environment.
`native:store:assets:generate` regenerates the versioned PNG store assets under
`docs/store-submission/assets/` using Playwright and the local SiraGPT brand
assets.
`native:store:packet` exports a non-secret `output/native-store-submission-packet/`
directory with platform-specific listing copy, privacy drafts, account-action
checklists, and copied assets for Google Play, App Store Connect, macOS, and
Windows submission work.
`native:store:owner-packet` builds on that packet and also includes the owner
handoff, release plan, blank signing input templates, manifest, ZIP archive,
and SHA-256 checksum. This is the portable non-secret handoff package to attach
to QA releases or share with the account owner before store submission.
`native:github-secrets:audit` checks which native signing secret names are
already configured in GitHub Actions for the public repository without reading
or printing secret values. `native:github-secrets:check` fails until all native
signing groups are configured. `native:github-secrets:report` writes a
non-secret Markdown/JSON status packet that separates GitHub Actions
availability from missing native signing and store-upload secret names.
`native:github-secrets:setup` uploads native signing secrets from local
environment variables or local file paths, base64-encoding file credentials
before piping them into `gh secret set`. Use `--dry-run` first; it prints only
secret names and source variable names, never secret values. `platform=android`
and `platform=ios` configure package-signing material only; use
`platform=googleplay` and `platform=appstore` separately for owner-approved
store-upload credentials.
`native:github-secrets:template` writes a blank owner-only template for the
selected platform, including the safer local `*_PATH` variables where a file can
be base64-encoded locally before upload. The template is a convenience artifact
for the account owner and must not be committed after values are filled.
`native:release:plan` generates a non-secret Markdown/JSON management packet
for the current repo, including missing GitHub secret names, per-platform
account actions, safe `gh secret set` commands, and the Actions-vs-signing
diagnosis that separates public repository workflow availability from missing
native signing material. Its release gate distinguishes package signing from
store upload, so a missing publisher API credential does not incorrectly mark
an already-signable package as unavailable. Artifact-only workflow inputs keep
store upload disabled; draft/internal upload inputs are listed separately.
`native:release:handoff` generates the owner handoff packet for Apple, Google,
macOS, and Windows account work. It includes the latest QA release link,
verified workflow run IDs, account-owner actions, secret names, dry-run
commands, and signed workflow targets. It must not contain any password,
keystore, certificate, provisioning profile, API private key, or cookie value.
After generated native release artifacts exist, `native:release:manifest`
generates the non-secret artifact manifest and `SHA256SUMS.txt` for that
artifact directory.
The mobile and desktop QA workflows generate the same files under
`output/native-qa/` before uploading platform artifacts, so short-lived Actions
downloads and durable GitHub Releases use the same verification format.
`native:release:plan:ci` generates the same packet from environment-variable
presence, which is how GitHub Actions can audit configured native secrets
without listing or printing secret values.

Windows has two distinct publication paths. The current NSIS/portable EXE
artifacts require trusted Authenticode signing for direct distribution or an
EXE-based Microsoft Store submission. An AppX/MSIX submission can be signed by
Microsoft after Store certification, but it still requires Partner Center
enrollment plus the reserved identity and publisher values. Do not report the
Windows certificate as mandatory when the owner chooses the Store-only
AppX/MSIX route.
The GitHub Actions workflow `Native readiness report` publishes both the
non-secret release plan, the GitHub secret-name report, the owner handoff
packet, and the store asset readiness report as artifacts.
