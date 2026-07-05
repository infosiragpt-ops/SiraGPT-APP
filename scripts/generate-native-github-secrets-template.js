#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const defaultRepo = process.env.GITHUB_REPOSITORY || "infosiragpt-ops/SiraGPT-APP"

const groupInputs = {
  android: [
    {
      secret: "ANDROID_KEYSTORE_BASE64",
      pathEnv: "ANDROID_KEYSTORE_PATH",
      label: "Android Play upload keystore file (.jks)",
    },
    { secret: "ANDROID_KEYSTORE_PASSWORD", label: "Android upload keystore password" },
    { secret: "ANDROID_KEY_ALIAS", label: "Android upload key alias" },
    { secret: "ANDROID_KEY_PASSWORD", label: "Android upload key password" },
  ],
  googleplay: [
    {
      secret: "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64",
      pathEnv: "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH",
      label: "Google Play service account JSON",
    },
  ],
  ios: [
    { secret: "APPLE_TEAM_ID", label: "Apple Developer team ID" },
    {
      secret: "IOS_SIGNING_CERTIFICATE_BASE64",
      pathEnv: "IOS_SIGNING_CERTIFICATE_PATH",
      label: "iOS signing certificate (.p12)",
    },
    { secret: "IOS_SIGNING_CERTIFICATE_PASSWORD", label: "iOS signing certificate password" },
    {
      secret: "IOS_PROVISIONING_PROFILE_BASE64",
      pathEnv: "IOS_PROVISIONING_PROFILE_PATH",
      label: "iOS provisioning profile (.mobileprovision)",
    },
  ],
  appstore: [
    { secret: "APP_STORE_CONNECT_API_KEY_ID", label: "App Store Connect API key ID" },
    { secret: "APP_STORE_CONNECT_API_ISSUER_ID", label: "App Store Connect API issuer ID" },
    {
      secret: "APP_STORE_CONNECT_API_KEY_BASE64",
      pathEnv: "APP_STORE_CONNECT_API_KEY_PATH",
      label: "App Store Connect API private key (.p8)",
    },
  ],
  macos: [
    {
      secret: "MACOS_CERTIFICATE_BASE64",
      pathEnv: "MACOS_CERTIFICATE_PATH",
      label: "macOS Developer ID certificate (.p12)",
    },
    { secret: "MACOS_CERTIFICATE_PASSWORD", label: "macOS certificate password" },
    { secret: "APPLE_TEAM_ID", label: "Apple Developer team ID" },
    { secret: "APPLE_ID", label: "Apple ID used for notarization" },
    { secret: "APPLE_APP_SPECIFIC_PASSWORD", label: "Apple app-specific password for notarization" },
  ],
  windows: [
    {
      secret: "WINDOWS_CERTIFICATE_BASE64",
      pathEnv: "WINDOWS_CERTIFICATE_PATH",
      label: "Windows code-signing certificate (.pfx/.p12)",
    },
    { secret: "WINDOWS_CERTIFICATE_PASSWORD", label: "Windows code-signing certificate password" },
  ],
}

const platformAliases = {
  all: ["android", "googleplay", "ios", "appstore", "macos", "windows"],
  mobile: ["android", "googleplay", "ios", "appstore"],
  desktop: ["macos", "windows"],
  apple: ["ios", "appstore", "macos"],
}

function usage() {
  return `Usage: node scripts/generate-native-github-secrets-template.js [--repo=owner/name] [--platform=all|mobile|desktop|apple|android|googleplay|ios|appstore|macos|windows] [--format=env|markdown|json] [--out=path]

Generates a non-secret owner template for native signing inputs. The template
contains variable names and comments only; it never reads or prints secret values.`
}

function parseArgs(argv) {
  const args = {
    repo: defaultRepo,
    platform: "all",
    format: "env",
    out: "",
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length)
    } else if (arg.startsWith("--platform=")) {
      args.platform = arg.slice("--platform=".length)
    } else if (arg.startsWith("--format=")) {
      args.format = arg.slice("--format=".length)
    } else if (arg.startsWith("--out=")) {
      args.out = arg.slice("--out=".length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!["env", "markdown", "json"].includes(args.format)) {
    throw new Error(`Unknown format: ${args.format}`)
  }

  return args
}

function unique(items) {
  return [...new Set(items)]
}

function expandPlatform(input) {
  const names = input
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)

  const expanded = names.length > 0
    ? names.flatMap((name) => platformAliases[name] || [name])
    : platformAliases.all

  const normalized = []
  for (const name of expanded) {
    if (!groupInputs[name]) {
      throw new Error(`Unknown platform or group: ${name}`)
    }
    normalized.push(name)
    if (name === "android") normalized.push("googleplay")
    if (name === "ios") normalized.push("appstore")
  }

  return unique(normalized)
}

function collectInputs(groups) {
  const bySecret = new Map()

  for (const group of groups) {
    for (const input of groupInputs[group]) {
      const existing = bySecret.get(input.secret)
      if (existing) {
        existing.groups.push(group)
      } else {
        bySecret.set(input.secret, {
          ...input,
          groups: [group],
        })
      }
    }
  }

  return [...bySecret.values()]
}

function createTemplate({ repo, platform }) {
  const groups = expandPlatform(platform)
  const inputs = collectInputs(groups)

  return {
    generatedAt: new Date().toISOString(),
    repo,
    platform,
    groups,
    inputs,
    commands: {
      dryRun: `npm run native:github-secrets:setup -- --repo=${repo} --platform=${platform} --dry-run`,
      upload: `npm run native:github-secrets:setup -- --repo=${repo} --platform=${platform}`,
      audit: `npm run native:github-secrets:audit -- --repo=${repo} --only-required`,
      check: `npm run native:github-secrets:check -- --repo=${repo}`,
    },
  }
}

function renderEnv(template) {
  const lines = []
  lines.push("# SiraGPT native GitHub secrets owner template")
  lines.push(`# Repository: ${template.repo}`)
  lines.push(`# Platform: ${template.platform}`)
  lines.push(`# Groups: ${template.groups.join(", ")}`)
  lines.push("#")
  lines.push("# Fill this only on a trusted local machine. Do not commit it.")
  lines.push("# Leave values blank in shared docs, screenshots, and support chats.")
  lines.push("# Normal mailbox/account passwords are not signing material.")
  lines.push("# For file credentials, prefer *_PATH; the setup script base64-encodes files locally.")
  lines.push("")

  for (const input of template.inputs) {
    lines.push(`# ${input.label}`)
    lines.push(`# Required by: ${input.groups.join(", ")}`)
    if (input.pathEnv) {
      lines.push(`${input.pathEnv}=`)
      lines.push(`# Alternative if already base64-encoded: ${input.secret}=`)
    } else {
      lines.push(`${input.secret}=`)
    }
    lines.push("")
  }

  lines.push("# Verify before uploading:")
  lines.push(`# ${template.commands.dryRun}`)
  lines.push("# Upload when the dry-run is clean:")
  lines.push(`# ${template.commands.upload}`)
  lines.push("# Audit configured GitHub secret names:")
  lines.push(`# ${template.commands.check}`)
  lines.push("")

  return `${lines.join("\n")}\n`
}

function renderMarkdown(template) {
  const lines = []
  lines.push("# SiraGPT Native GitHub Secrets Owner Template")
  lines.push("")
  lines.push(`Generated: ${template.generatedAt}`)
  lines.push(`Repository: \`${template.repo}\``)
  lines.push(`Platform: \`${template.platform}\``)
  lines.push(`Groups: \`${template.groups.join(", ")}\``)
  lines.push("")
  lines.push("This document contains names only. Do not paste secret values into Markdown, issues, PRs, chat, screenshots, or commits.")
  lines.push("")
  lines.push("| Input | File path alternative | Required by |")
  lines.push("| --- | --- | --- |")
  for (const input of template.inputs) {
    lines.push(`| \`${input.secret}\` | ${input.pathEnv ? `\`${input.pathEnv}\`` : "none"} | ${input.groups.map((group) => `\`${group}\``).join(", ")} |`)
  }
  lines.push("")
  lines.push("## Commands")
  lines.push("")
  lines.push("```bash")
  lines.push(template.commands.dryRun)
  lines.push(template.commands.upload)
  lines.push(template.commands.check)
  lines.push("```")
  lines.push("")
  return `${lines.join("\n")}\n`
}

function renderJson(template) {
  return `${JSON.stringify(template, null, 2)}\n`
}

function writeOutput(outPath, contents) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, contents)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const template = createTemplate({
    repo: args.repo,
    platform: args.platform,
  })
  const output = args.format === "json"
    ? renderJson(template)
    : args.format === "markdown"
      ? renderMarkdown(template)
      : renderEnv(template)

  if (args.out) {
    writeOutput(path.resolve(root, args.out), output)
  }
  process.stdout.write(output)
}

try {
  main()
} catch (error) {
  console.error(`native-github-secrets-template: ${error.message}`)
  process.exit(2)
}
