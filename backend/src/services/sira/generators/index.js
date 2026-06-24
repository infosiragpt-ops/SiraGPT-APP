"use strict";

/**
 * Generator aggregator — exposes the in-process Node generators as a
 * provider map compatible with document-pipeline-registry's
 * `dispatchGenerate({ providers })` contract.
 *
 * Each provider is an async fn `({ format, plan, mime }) → output` where
 * `output` is `{ buffer, mime, extension }` (the shape the dispatcher
 * sanity-checks before returning). Pure functions, no I/O — safe to
 * invoke from any worker.
 *
 * The provider IDs match the IDs declared in
 *   backend/src/services/sira/document-pipeline-registry.js
 * so the registry's `chooseGenerators({ format })` ranking flows
 * naturally into `dispatchGenerate({ providers: getLocalProviders() })`.
 *
 * Coverage today (Node-only, zero binary deps):
 *   sira-rtf  → application/rtf
 *   sira-odt  → application/vnd.oasis.opendocument.text
 *   sira-epub → application/epub+zip
 *   sira-markdown-frontmatter → text/markdown
 *   text-writer/json-writer/csv-writer/tsv-writer/yaml-writer/xml-writer/
 *   ndjson-writer/ics-writer/vcf-writer/bibtex-writer → plain text formats
 *
 * Adding a generator: register its module here and the registry will
 * pick it up automatically through its declared preference rank.
 */

const { generateRtf } = require("./rtf");
const { generateOdt } = require("./odt");
const { generateEpub } = require("./epub");
const { generateMarkdownFrontmatter } = require("./markdown-frontmatter");
const {
  generateText,
  generateJson,
  generateCsv,
  generateTsv,
  generateYaml,
  generateXml,
  generateNdjson,
  generateIcs,
  generateVcf,
  generateBibtex,
} = require("./text-writers");

/**
 * Wraps a sync `generate*` function in the async provider shape required
 * by `dispatchGenerate`. The dispatcher inspects only `buffer`/`dataUrl`
 * + `mime` on the returned object, so we passthrough the generator's
 * payload verbatim and tag the format for downstream callers that want
 * to route by it.
 */
function wrap(fn, defaultFormat) {
  return async function provider({ format, plan, mime } = {}) {
    const out = fn(plan);
    if (!out || (!out.buffer && !out.dataUrl)) {
      throw new Error(`generator returned empty output for ${format || defaultFormat}`);
    }
    return {
      buffer: out.buffer,
      mime: out.mime || mime,
      extension: out.extension || defaultFormat,
      format: format || defaultFormat,
    };
  };
}

/**
 * @returns {Record<string, (args: { format?: string, plan?: any, mime?: string }) => Promise<{ buffer: Buffer, mime: string, extension: string, format: string }>>}
 */
function getLocalProviders() {
  return {
    "sira-rtf": wrap(generateRtf, "rtf"),
    // rtf-writer is the registry's lower-preference node RTF fallback (pref 80
    // vs sira-rtf's 86). It had no provider, so dispatchGenerate marked it
    // provider_not_injected and the declared fallback could never run. Wire it
    // to the same deterministic generator so the belt-and-suspenders is real;
    // sira-rtf still wins on preference, so no current behavior changes.
    "rtf-writer": wrap(generateRtf, "rtf"),
    "sira-odt": wrap(generateOdt, "odt"),
    "sira-epub": wrap(generateEpub, "epub"),
    "sira-markdown-frontmatter": wrap(generateMarkdownFrontmatter, "md"),
    // Node-native text-format writers (previously declared in the registry
    // but unimplemented — calling these formats used to throw
    // all_generators_failed). Zero binary deps.
    "text-writer": wrap(generateText, "txt"),
    "json-writer": wrap(generateJson, "json"),
    "csv-writer": wrap(generateCsv, "csv"),
    "tsv-writer": wrap(generateTsv, "tsv"),
    "yaml-writer": wrap(generateYaml, "yaml"),
    "xml-writer": wrap(generateXml, "xml"),
    "ndjson-writer": wrap(generateNdjson, "ndjson"),
    "ics-writer": wrap(generateIcs, "ics"),
    "vcf-writer": wrap(generateVcf, "vcf"),
    "bibtex-writer": wrap(generateBibtex, "bib"),
  };
}

/**
 * Convenience: full one-shot dispatch using the local provider set.
 * Returns the dispatcher's success envelope (`{ format, generator_used,
 * output, errors }`). Throws if no provider in the registry's
 * preference-ranked list succeeds.
 *
 * @param {object} args
 * @param {string} args.format
 * @param {*} args.plan
 * @param {object} [args.runtime]    forwarded to chooseGenerators (default: node-only)
 * @param {object} [args.requires]   forwarded to chooseGenerators
 */
async function generateWithLocalProviders({ format, plan, runtime, requires } = {}) {
  const registry = require("../document-pipeline-registry");
  return registry.dispatchGenerate({
    format,
    plan,
    requires,
    runtime: runtime || { node: true, python: false, binary: false },
    providers: getLocalProviders(),
  });
}

module.exports = {
  getLocalProviders,
  generateWithLocalProviders,
};
