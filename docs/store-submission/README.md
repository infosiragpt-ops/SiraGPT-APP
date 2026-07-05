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
- Latest public QA packet: `native-qa-v0.4.3-0fb0493`
  (`0fb0493464b841c11924e9ff9a087209fb8d25dd`)
- Latest verified native runs:
  - Mobile: `28725624118`
  - Desktop: `28725624116`
  - Readiness report: `28725476833`
- Distribution tracker: https://github.com/infosiragpt-ops/SiraGPT-APP/issues/4

The canonical draft metadata lives in
`docs/store-submission/native-store-metadata.json`. The store asset manifest
lives in `docs/store-submission/native-store-assets.json`.

## Submission Order

1. Keep `production-main` green for web, desktop, and mobile wrapper builds.
2. Complete owner-only account verification in Google Play Console and Apple
   Developer/App Store Connect.
3. Add signing and store-upload secrets to GitHub Actions, never to the repo.
4. Run `npm run native:store:readiness`, `npm run native:store:assets`, and
   `npm run native:readiness:all`.
5. Build signed packages through `Native signed release packages`.
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
key, and Windows code-signing certificate.

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

The Windows package can be built as NSIS installer and portable executable.
For a professional public release, sign both with a Windows code-signing
certificate. Microsoft Store publication also needs Partner Center metadata,
logos, screenshots, and the privacy URL.

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
npm run native:readiness
npm run native:readiness:all
npm run native:github-secrets:audit
npm run native:github-secrets:check
npm run native:github-secrets:setup -- --platform=all --dry-run
npm run native:release:plan
npm run native:release:plan:ci
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
`native:github-secrets:audit` checks which native signing secret names are
already configured in GitHub Actions for the public repository without reading
or printing secret values. `native:github-secrets:check` fails until all native
signing groups are configured.
`native:github-secrets:setup` uploads native signing secrets from local
environment variables or local file paths, base64-encoding file credentials
before piping them into `gh secret set`. Use `--dry-run` first; it prints only
secret names and source variable names, never secret values.
`native:release:plan` generates a non-secret Markdown/JSON management packet
for the current repo, including missing GitHub secret names, per-platform
account actions, and safe `gh secret set` commands.
`native:release:handoff` generates the owner handoff packet for Apple, Google,
macOS, and Windows account work. It includes the latest QA release link,
verified workflow run IDs, account-owner actions, secret names, dry-run
commands, and signed workflow targets. It must not contain any password,
keystore, certificate, provisioning profile, API private key, or cookie value.
After generated native release artifacts exist, `native:release:manifest`
generates the non-secret artifact manifest and `SHA256SUMS.txt` for that
artifact directory.
`native:release:plan:ci` generates the same packet from environment-variable
presence, which is how GitHub Actions can audit configured native secrets
without listing or printing secret values.
The GitHub Actions workflow `Native readiness report` publishes both the
non-secret release plan, the owner handoff packet, and the store asset
readiness report as artifacts.
