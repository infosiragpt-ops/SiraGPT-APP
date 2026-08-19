#!/usr/bin/env node

const { execFileSync } = require("node:child_process")
const { readFileSync } = require("node:fs")
const { X509Certificate } = require("node:crypto")

function normalizeSha1(value, label = "SHA-1 fingerprint") {
  const compact = String(value || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase()
  if (!/^[A-F0-9]{40}$/.test(compact)) {
    throw new Error(`${label} must contain exactly 40 hexadecimal characters`)
  }
  return compact.match(/.{2}/g).join(":")
}

function assertSha1Match(actual, expected) {
  const actualNormalized = normalizeSha1(actual, "Actual SHA-1 fingerprint")
  const expectedNormalized = normalizeSha1(expected, "Expected SHA-1 fingerprint")
  if (actualNormalized !== expectedNormalized) {
    throw new Error(
      `Android upload certificate mismatch: expected ${expectedNormalized}, got ${actualNormalized}`,
    )
  }
  return actualNormalized
}

function parseArgs(argv) {
  const values = {}
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) continue
    const separator = arg.indexOf("=")
    values[arg.slice(2, separator)] = arg.slice(separator + 1)
  }
  return values
}

function readCertificatePem({ aabPath, certificatePath }) {
  if (certificatePath) {
    return readFileSync(certificatePath, "utf8")
  }
  if (!aabPath) {
    throw new Error("Provide --aab=path or --certificate=path")
  }
  return execFileSync(
    process.env.KEYTOOL_BIN || "keytool",
    ["-printcert", "-rfc", "-jarfile", aabPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const expected = args["expected-sha1"] || process.env.ANDROID_PLAY_UPLOAD_SHA1
  if (!expected) {
    throw new Error(
      "ANDROID_PLAY_UPLOAD_SHA1 is required; set it to the upload certificate fingerprint registered in Google Play",
    )
  }

  const pem = readCertificatePem({
    aabPath: args.aab,
    certificatePath: args.certificate,
  })
  const certificate = new X509Certificate(pem)
  const verified = assertSha1Match(certificate.fingerprint, expected)
  console.log(`android-play-upload-certificate-sha1=${verified}`)
  console.log("android-play-upload-certificate-status=verified")
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`verify-android-upload-certificate: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  assertSha1Match,
  normalizeSha1,
  parseArgs,
}
