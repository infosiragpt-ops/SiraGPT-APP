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
6. Upload only after manual confirmation because binaries and store metadata
   are transmitted to third-party platforms.

## Platform Notes

### Android

Google Play requires the Data safety form and a privacy policy for published
apps. The draft data declaration is in the metadata JSON and must be reviewed
against the live app behavior, all providers, and SDKs before submission.

Current account blockers are owner actions:

- Identity verification.
- Real Android device verification in Play Console.
- Contact phone verification.

### iPhone

App Store Connect requires app privacy details, privacy policy URL, age rating,
screenshots, review information, signing, and an uploaded build. The app uses
the Capacitor bundle ID `com.siragpt.app`; do not create a different bundle ID
unless the native project and metadata are updated together.

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
`native:release:plan` generates a non-secret Markdown/JSON management packet
for the current repo, including missing GitHub secret names, per-platform
account actions, and safe `gh secret set` commands.
`native:release:plan:ci` generates the same packet from environment-variable
presence, which is how GitHub Actions can audit configured native secrets
without listing or printing secret values.
The GitHub Actions workflow `Native readiness report` publishes both the
non-secret release plan and the store asset readiness report as artifacts.
