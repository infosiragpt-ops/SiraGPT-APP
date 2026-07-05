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
- Latest public QA packet: `native-qa-v0.4.3-0601139`
  (`0601139e3b507b9733ad1fdd84290e3d8cf7a078`)
- Last verified native QA runs:
  - Mobile: `28732348269`
  - Desktop: `28732348253`
  - Readiness report: `28732703296`
  - CI: `28732703286`
- Latest native artifact verification SHA: `0601139e3b507b9733ad1fdd84290e3d8cf7a078`
  (`fix(ci): run database backup through postgres container`)
- Management/traceability SHA validated before this packet refresh: `1d937068b66facec31e752c37ad30760f7b86aa3`
  (`docs(native): publish QA package for current production`)
- Latest QA artifact manifest verification: mobile run `28732348269` and
  desktop run `28732348253` were downloaded and each Android, iOS simulator,
  macOS, and Windows artifact upload includes `native-release-manifest.json`,
  `native-release-manifest.md`, and `SHA256SUMS.txt`.
- Durable QA ZIP: `SiraGPT-native-qa-v0.4.3-0601139.zip`
  (`sha256:5d978589737f09d1f9f02839b9551f53afa0cef6a7daf9ccf675d0e6321051f6`)
  preserves Android, iOS, macOS, and Windows folders plus original Windows
  filenames.
- Distribution tracker: https://github.com/infosiragpt-ops/SiraGPT-APP/issues/4
- Latest owner handoff packet: `SiraGPT-native-store-owner-packet-0601139e.zip`
  (`https://github.com/infosiragpt-ops/SiraGPT-APP/releases/download/native-qa-v0.4.3-0601139/SiraGPT-native-store-owner-packet-0601139e.zip`)
  with SHA-256 `fefc5532f8cfaf3e5baf55d9e7a5cb9400f2d3aad71e2e1be95f2bc9f6210f03`.
- Latest signed release preflight: `28728938916`
  (`https://github.com/infosiragpt-ops/SiraGPT-APP/actions/runs/28728938916`)
  stopped before package runners because signing secrets are still missing.
- Latest secret-name audit: public repository Actions are running, but signed
  native release packaging is blocked by missing platform signing and
  store-upload secret names.
- GitHub Actions diagnostics snapshot: repository visibility is `PUBLIC`, Actions
  is enabled with `allowed_actions=all`, CI run `28732703286` and native
  readiness run `28732703296` are green. Standard GitHub-hosted Actions for
  public repositories are free; this is separate from native signing readiness.

The canonical draft metadata lives in
`docs/store-submission/native-store-metadata.json`. The store asset manifest
lives in `docs/store-submission/native-store-assets.json`.

## Submission Order

1. Keep `production-main` green for web, desktop, and mobile wrapper builds.
   The `Native mobile builds` and `Native desktop builds` workflow artifacts
   must include `native-release-manifest.json`, `native-release-manifest.md`,
   and `SHA256SUMS.txt` alongside every QA binary upload.
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
npm run native:store:owner-packet
npm run native:readiness
npm run native:readiness:all
npm run native:github-secrets:audit
npm run native:github-secrets:check
npm run native:github-secrets:template -- --platform=all --out=output/native-signing.env.example
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
`native:store:owner-packet` builds on that packet and also includes the owner
handoff, release plan, blank signing input templates, manifest, ZIP archive,
and SHA-256 checksum. This is the portable non-secret handoff package to attach
to QA releases or share with the account owner before store submission.
`native:github-secrets:audit` checks which native signing secret names are
already configured in GitHub Actions for the public repository without reading
or printing secret values. `native:github-secrets:check` fails until all native
signing groups are configured.
`native:github-secrets:setup` uploads native signing secrets from local
environment variables or local file paths, base64-encoding file credentials
before piping them into `gh secret set`. Use `--dry-run` first; it prints only
secret names and source variable names, never secret values.
`native:github-secrets:template` writes a blank owner-only template for the
selected platform, including the safer local `*_PATH` variables where a file can
be base64-encoded locally before upload. The template is a convenience artifact
for the account owner and must not be committed after values are filled.
`native:release:plan` generates a non-secret Markdown/JSON management packet
for the current repo, including missing GitHub secret names, per-platform
account actions, safe `gh secret set` commands, and the Actions-vs-signing
diagnosis that separates public repository workflow availability from missing
native signing material.
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
The GitHub Actions workflow `Native readiness report` publishes both the
non-secret release plan, the owner handoff packet, and the store asset
readiness report as artifacts.
