import assert from "node:assert/strict"
import { join } from "node:path"
import { describe, it } from "node:test"

const {
  assertSha1Match,
  normalizeSha1,
  parseArgs,
} = require(join(process.cwd(), "scripts/verify-android-upload-certificate.js")) as {
  assertSha1Match(actual: string, expected: string): string
  normalizeSha1(value: string, label?: string): string
  parseArgs(args: string[]): Record<string, string>
}

describe("Android Play upload certificate guard", () => {
  const fingerprint = "AC:6B:C7:E4:48:6B:5D:84:47:83:56:7F:7F:8E:59:6C:3F:1A:DF:0D"

  it("normalizes fingerprints without weakening the full SHA-1 check", () => {
    assert.equal(
      normalizeSha1(fingerprint.toLowerCase().replace(/:/g, "")),
      fingerprint,
    )
    assert.throws(() => normalizeSha1("AC:6B"), /exactly 40 hexadecimal/)
  })

  it("rejects a signing certificate that differs from Google Play", () => {
    assert.equal(assertSha1Match(fingerprint, fingerprint), fingerprint)
    assert.throws(
      () =>
        assertSha1Match(
          fingerprint,
          "6D:79:46:5E:D9:E6:15:58:BC:0C:B5:A0:05:52:64:78:6F:EA:C6:31",
        ),
      /Android upload certificate mismatch/,
    )
  })

  it("parses explicit artifact and fingerprint arguments", () => {
    assert.deepEqual(
      parseArgs([
        "--aab=output/SiraGPT.aab",
        `--expected-sha1=${fingerprint}`,
        "--ignored",
      ]),
      {
        aab: "output/SiraGPT.aab",
        "expected-sha1": fingerprint,
      },
    )
  })
})
