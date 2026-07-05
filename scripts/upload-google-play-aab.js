#!/usr/bin/env node

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

const androidPublisherScope = "https://www.googleapis.com/auth/androidpublisher"
const tokenUrl = "https://oauth2.googleapis.com/token"
const apiBase = "https://androidpublisher.googleapis.com/androidpublisher/v3"
const uploadBase = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3"
const allowedStatuses = new Set(["draft", "completed", "inProgress", "halted"])

function usage() {
  return `Usage: node scripts/upload-google-play-aab.js --aab=path --package=com.siragpt.app --track=qa --status=draft [--release-name=name] [--user-fraction=0.05] [--dry-run]

Uploads a signed Android App Bundle to Google Play through the Android Publisher API.

Secrets are read from one of these environment variables:
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH

The script prints only non-secret package, track, release, and version data.`
}

function parseArgs(argv) {
  const args = {
    aab: "",
    packageName: "",
    track: "qa",
    status: "draft",
    releaseName: "",
    userFraction: "",
    dryRun: false,
  }

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      args.help = true
    } else if (arg === "--dry-run") {
      args.dryRun = true
    } else if (arg.startsWith("--aab=")) {
      args.aab = arg.slice("--aab=".length)
    } else if (arg.startsWith("--package=")) {
      args.packageName = arg.slice("--package=".length)
    } else if (arg.startsWith("--track=")) {
      args.track = arg.slice("--track=".length)
    } else if (arg.startsWith("--status=")) {
      args.status = arg.slice("--status=".length)
    } else if (arg.startsWith("--release-name=")) {
      args.releaseName = arg.slice("--release-name=".length)
    } else if (arg.startsWith("--user-fraction=")) {
      args.userFraction = arg.slice("--user-fraction=".length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function validateArgs(args) {
  if (!args.aab) throw new Error("--aab is required")
  if (!args.packageName) throw new Error("--package is required")
  if (!args.track) throw new Error("--track is required")
  if (!allowedStatuses.has(args.status)) {
    throw new Error(`--status must be one of: ${[...allowedStatuses].join(", ")}`)
  }

  const aabPath = path.resolve(args.aab)
  const stat = fs.existsSync(aabPath) ? fs.statSync(aabPath) : null
  if (!stat || !stat.isFile()) {
    throw new Error(`AAB file not found: ${aabPath}`)
  }

  if (args.userFraction) {
    const value = Number(args.userFraction)
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new Error("--user-fraction must be a number greater than 0 and less than 1")
    }
    if (args.status !== "inProgress") {
      throw new Error("--user-fraction is only valid when --status=inProgress")
    }
  }

  if (args.status === "inProgress" && !args.userFraction) {
    throw new Error("--user-fraction is required when --status=inProgress")
  }

  return {
    ...args,
    aab: aabPath,
    releaseName: args.releaseName || `SiraGPT ${new Date().toISOString().slice(0, 10)}`,
  }
}

function readServiceAccount() {
  const fromBase64 = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64
  const fromJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
  const fromPath = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH

  let raw = ""
  if (fromBase64 && fromBase64.trim()) {
    raw = Buffer.from(fromBase64.trim(), "base64").toString("utf8")
  } else if (fromJson && fromJson.trim()) {
    raw = fromJson
  } else if (fromPath && fromPath.trim()) {
    raw = fs.readFileSync(path.resolve(fromPath), "utf8")
  } else {
    throw new Error("Missing Google Play service account secret")
  }

  const account = JSON.parse(raw)
  if (!account.client_email || !account.private_key) {
    throw new Error("Google Play service account JSON must include client_email and private_key")
  }

  return account
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function createJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: "RS256",
    typ: "JWT",
  }
  const payload = {
    iss: serviceAccount.client_email,
    scope: androidPublisherScope,
    aud: tokenUrl,
    exp: now + 3600,
    iat: now,
  }
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(signingInput), serviceAccount.private_key)
    .toString("base64url")

  return `${signingInput}.${signature}`
}

async function parseApiError(response, context) {
  const text = await response.text()
  let message = text
  try {
    const json = JSON.parse(text)
    message = json.error?.message || json.error_description || text
  } catch {
    // Keep the raw body.
  }
  throw new Error(`${context} failed (${response.status}): ${message}`)
}

async function fetchAccessToken(serviceAccount) {
  const assertion = createJwt(serviceAccount)
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  })

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  })

  if (!response.ok) await parseApiError(response, "Google OAuth token request")
  const json = await response.json()
  if (!json.access_token) throw new Error("Google OAuth token response did not include access_token")
  return json.access_token
}

async function apiJson(token, url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) await parseApiError(response, url)
  return response.json()
}

async function uploadBundle(token, url, aabPath) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: fs.readFileSync(aabPath),
  })

  if (!response.ok) await parseApiError(response, "Google Play bundle upload")
  return response.json()
}

function releaseBody(args, versionCode) {
  const release = {
    name: args.releaseName,
    versionCodes: [String(versionCode)],
    status: args.status,
  }

  if (args.status === "inProgress") {
    release.userFraction = Number(args.userFraction)
  }

  return {
    track: args.track,
    releases: [release],
  }
}

async function uploadToGooglePlay(args) {
  const packagePath = encodeURIComponent(args.packageName)
  const serviceAccount = readServiceAccount()
  const token = await fetchAccessToken(serviceAccount)

  console.log(`Google Play upload: package=${args.packageName} track=${args.track} status=${args.status}`)

  const edit = await apiJson(token, `${apiBase}/applications/${packagePath}/edits`, {
    method: "POST",
    body: {},
  })
  if (!edit.id) throw new Error("Google Play edit insert did not return an edit id")

  const editPath = encodeURIComponent(edit.id)
  const uploadedBundle = await uploadBundle(
    token,
    `${uploadBase}/applications/${packagePath}/edits/${editPath}/bundles?uploadType=media`,
    args.aab,
  )

  if (!uploadedBundle.versionCode) {
    throw new Error("Google Play bundle upload did not return a versionCode")
  }

  await apiJson(
    token,
    `${apiBase}/applications/${packagePath}/edits/${editPath}/tracks/${encodeURIComponent(args.track)}`,
    {
      method: "PUT",
      body: releaseBody(args, uploadedBundle.versionCode),
    },
  )

  await apiJson(token, `${apiBase}/applications/${packagePath}/edits/${editPath}:commit`, {
    method: "POST",
    body: {},
  })

  console.log(`Google Play upload complete: versionCode=${uploadedBundle.versionCode} edit=${edit.id}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const validated = validateArgs(args)
  if (validated.dryRun) {
    console.log("Google Play upload dry-run")
    console.log(`package: ${validated.packageName}`)
    console.log(`aab: ${validated.aab}`)
    console.log(`track: ${validated.track}`)
    console.log(`status: ${validated.status}`)
    console.log(`releaseName: ${validated.releaseName}`)
    if (validated.userFraction) console.log(`userFraction: ${validated.userFraction}`)
    return
  }

  await uploadToGooglePlay(validated)
}

main().catch((error) => {
  console.error(`upload-google-play-aab: ${error.message}`)
  process.exit(1)
})
