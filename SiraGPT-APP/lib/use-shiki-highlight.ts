"use client";

import { useEffect, useState } from "react";

/**
 * useShikiHighlight — async client-side syntax highlighting via Shiki.
 *
 * Why Shiki: same TextMate grammars VS Code uses, so the output matches
 * what users see in their editor. Replaces react-syntax-highlighter
 * inside CustomCodeBlock without changing that component's public API
 * (its consumers — CodeBlock in message-component, ArtifactPanel,
 * ArtifactCard — keep working).
 *
 * Lazy-loaded via `import('shiki')` so the ~1 MB grammar bundle
 * code-splits into its own chunk; the chat shell stays light. Languages
 * load on demand the first time they're requested, then cache in the
 * Shiki singleton.
 *
 * Returns `null` while the highlighter loads / when highlighting fails.
 * The caller renders a plain `<pre>` fallback in that case so the user
 * still sees the code without color.
 */

type CodeToHtml = (code: string, opts: { lang: string; theme: string }) => Promise<string>;

let _codeToHtml: Promise<CodeToHtml> | null = null;

function getCodeToHtml(): Promise<CodeToHtml> {
  if (!_codeToHtml) {
    _codeToHtml = import("shiki").then((m) => m.codeToHtml as unknown as CodeToHtml);
  }
  return _codeToHtml;
}

const FALLBACK_LANG = "text";

// Languages Shiki supports natively; anything else falls back to plain text
// so codeToHtml doesn't reject. Kept inline to avoid an extra round-trip
// for an O(1) lookup.
const SUPPORTED_LANGS = new Set([
  "abap","actionscript-3","ada","apache","applescript","ara","asciidoc","asm","astro",
  "awk","ballerina","bat","batch","beancount","berry","bibtex","bicep","blade","c",
  "cadence","clarity","clojure","cmake","cobol","codeowners","codeql","coffee","cpp",
  "crystal","csharp","css","csv","cue","cypher","d","dart","dax","desktop","diff",
  "docker","dockerfile","dotenv","dream-maker","edge","elixir","elm","emacs-lisp",
  "erb","erlang","fennel","fish","fluent","fortran-fixed-form","fortran-free-form",
  "fsharp","fsl","gdresource","gdscript","gdshader","genie","gherkin","git-commit",
  "git-rebase","gleam","glimmer-js","glimmer-ts","glsl","gnuplot","go","graphql",
  "groovy","hack","haml","handlebars","haskell","haxe","hcl","hjson","hlsl","html",
  "html-derivative","http","hxml","hy","imba","ini","java","javascript","jinja",
  "jison","json","json5","jsonc","jsonl","jsonnet","jssm","jsx","julia","kotlin",
  "kusto","latex","lean","less","liquid","lisp","logo","lua","luau","make","markdown",
  "marko","matlab","mdc","mdx","mermaid","mipsasm","mojo","move","narrat","nextflow",
  "nginx","nim","nix","nushell","objective-c","objective-cpp","ocaml","pascal","perl",
  "php","plsql","po","postcss","powerquery","powershell","prisma","prolog","proto",
  "ps","ps1","pug","puppet","purescript","python","qml","qmldir","qss","r","racket",
  "raku","razor","reg","regexp","rel","riscv","rst","ruby","rust","sas","sass","scala",
  "scheme","scss","sdbl","shaderlab","shell","shellscript","shellsession","smalltalk",
  "solidity","soy","sparql","splunk","sql","ssh-config","stata","stylus","svelte",
  "swift","system-verilog","systemd","tasl","tcl","templ","terraform","tex","toml",
  "ts-tags","tsv","tsx","turtle","twig","typescript","typespec","typst","v","vala",
  "vb","verilog","vhdl","viml","vue","vue-html","vyper","wasm","wenyan","wgsl","wikitext",
  "wolfram","xml","xsl","yaml","zenscript","zig","js","ts","sh","bash","md","yml",
]);

function normaliseLang(lang: string): string {
  const l = (lang || "").toLowerCase().trim();
  if (!l) return FALLBACK_LANG;
  if (SUPPORTED_LANGS.has(l)) return l;
  return FALLBACK_LANG;
}

export function useShikiHighlight(
  code: string,
  lang: string,
  theme: string = "one-dark-pro",
): string | null {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!code) {
      setHtml(null);
      return;
    }
    const safeLang = normaliseLang(lang);
    getCodeToHtml()
      .then((codeToHtml) => codeToHtml(code, { lang: safeLang, theme }))
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  return html;
}
