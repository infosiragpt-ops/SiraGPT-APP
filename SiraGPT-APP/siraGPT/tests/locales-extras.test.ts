import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  COUNTRY_TO_LOCALE,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  isRTL,
  isSupportedLocale,
  LOCALES,
  localeForCountry,
  localeInfo,
  RTL_LOCALES,
  SUPPORTED_LOCALES,
} from "../lib/i18n/locales"

/**
 * locales.ts is the single source of truth for our i18n surface.
 * tests/locale-resolution.test.ts already covers the header-parsing
 * path; this file pins:
 *
 *   - LOCALES catalog shape (unique codes, every entry has dir/name)
 *   - isRTL / RTL_LOCALES alignment
 *   - localeInfo lookup + fallback
 *   - isSupportedLocale guard
 *   - localeForCountry: known mapping, unsupported fall-back to default
 *   - DEFAULT_LOCALE / FALLBACK_LOCALE constants
 */

describe("LOCALES catalog", () => {
  it("has unique codes across the catalog", () => {
    const codes = LOCALES.map((l) => l.code)
    assert.equal(new Set(codes).size, codes.length)
  })

  it("every entry has all required fields populated", () => {
    for (const l of LOCALES) {
      assert.ok(l.code, "code missing")
      assert.ok(l.name, "name missing")
      assert.ok(l.english, "english missing")
      assert.ok(l.dir === "ltr" || l.dir === "rtl", `bad dir on ${l.code}`)
    }
  })

  it("SUPPORTED_LOCALES mirrors LOCALES codes", () => {
    assert.equal(SUPPORTED_LOCALES.length, LOCALES.length)
    for (const l of LOCALES) {
      assert.ok(SUPPORTED_LOCALES.includes(l.code))
    }
  })
})

describe("default + fallback constants", () => {
  it("DEFAULT_LOCALE is 'es' and is in the catalog", () => {
    assert.equal(DEFAULT_LOCALE, "es")
    assert.ok(SUPPORTED_LOCALES.includes(DEFAULT_LOCALE))
  })

  it("FALLBACK_LOCALE is 'en' and is in the catalog", () => {
    assert.equal(FALLBACK_LOCALE, "en")
    assert.ok(SUPPORTED_LOCALES.includes(FALLBACK_LOCALE))
  })
})

describe("isRTL / RTL_LOCALES alignment", () => {
  it("includes Arabic, Hebrew, Persian, Urdu, Pashto", () => {
    assert.ok(isRTL("ar"))
    assert.ok(isRTL("he"))
    assert.ok(isRTL("fa"))
    assert.ok(isRTL("ur"))
    assert.ok(isRTL("ps"))
  })

  it("returns false for LTR locales", () => {
    assert.equal(isRTL("es"), false)
    assert.equal(isRTL("en"), false)
    assert.equal(isRTL("ja"), false)
  })

  it("RTL_LOCALES set matches dir === 'rtl' filter", () => {
    const expected = new Set(LOCALES.filter((l) => l.dir === "rtl").map((l) => l.code))
    assert.deepEqual([...RTL_LOCALES].sort(), [...expected].sort())
  })
})

describe("localeInfo", () => {
  it("returns the matching info for a known code", () => {
    const info = localeInfo("ja")
    assert.equal(info.code, "ja")
    assert.equal(info.english, "Japanese")
  })

  it("falls back to LOCALES[0] (Spanish) for unknown code", () => {
    const info = localeInfo("xx-not-real")
    assert.equal(info.code, "es")
  })
})

describe("isSupportedLocale", () => {
  it("returns true for codes in the catalog", () => {
    assert.equal(isSupportedLocale("es"), true)
    assert.equal(isSupportedLocale("ja"), true)
  })

  it("returns false for null / undefined / empty / unknown", () => {
    assert.equal(isSupportedLocale(null), false)
    assert.equal(isSupportedLocale(undefined), false)
    assert.equal(isSupportedLocale(""), false)
    assert.equal(isSupportedLocale("klingon"), false)
  })
})

describe("localeForCountry", () => {
  it("falls back to DEFAULT_LOCALE when country is null / undefined / empty", () => {
    assert.equal(localeForCountry(null), DEFAULT_LOCALE)
    assert.equal(localeForCountry(undefined), DEFAULT_LOCALE)
    assert.equal(localeForCountry(""), DEFAULT_LOCALE)
  })

  it("falls back to DEFAULT_LOCALE for unmapped country", () => {
    assert.equal(localeForCountry("ZZ"), DEFAULT_LOCALE)
  })

  it("maps Spanish-speaking Latin America correctly", () => {
    assert.equal(localeForCountry("MX"), "es")
    assert.equal(localeForCountry("AR"), "es")
    assert.equal(localeForCountry("CO"), "es")
  })

  it("maps Portuguese-speaking countries to pt", () => {
    assert.equal(localeForCountry("BR"), "pt")
    assert.equal(localeForCountry("PT"), "pt")
  })

  it("maps Japan / Korea / Mainland China correctly", () => {
    assert.equal(localeForCountry("JP"), "ja")
    assert.equal(localeForCountry("KR"), "ko")
    assert.equal(localeForCountry("CN"), "zh")
  })

  it("is case-insensitive on the input country code", () => {
    assert.equal(localeForCountry("mx"), "es")
    assert.equal(localeForCountry("Mx"), "es")
  })
})

describe("COUNTRY_TO_LOCALE contract", () => {
  it("every mapped locale is in SUPPORTED_LOCALES", () => {
    for (const code of Object.values(COUNTRY_TO_LOCALE)) {
      assert.ok(
        SUPPORTED_LOCALES.includes(code),
        `country mapping yields unsupported locale: ${code}`,
      )
    }
  })

  it("country codes are 2-letter uppercase", () => {
    for (const country of Object.keys(COUNTRY_TO_LOCALE)) {
      assert.match(country, /^[A-Z]{2}$/)
    }
  })
})
